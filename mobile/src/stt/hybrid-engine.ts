/**
 * Hybrid STT engine: zipformer streaming + Canary offline second-pass.
 *
 * Single PCM audio stream feeds BOTH:
 *   1. Sherpa zipformer (real-time rough text)
 *   2. Audio buffer (accumulated for offline Canary pass)
 *
 * The offline pass writes audio to a temp WAV file and uses
 * transcribeFileOffline() to avoid the React Native bridge overhead
 * of passing 100K+ floats as a JSON array (which caused silent
 * failures for segments > 5 seconds).
 *
 * Timing: 5s min between passes, 3s min audio, 30s max without pass.
 */

import * as FileSystem from "expo-file-system/legacy";
import { createPcmLiveStream } from "react-native-sherpa-onnx/audio";
import type { PcmLiveStreamHandle } from "react-native-sherpa-onnx/audio";
import type { SttStream } from "react-native-sherpa-onnx/stt";
import { getSherpaEngine } from "./sherpa-streaming";
import { transcribeFileOffline, isWhisperReady, resetOfflineEngine } from "./whisper-offline";
import { applyCorrections } from "../pipeline/correct";
import {
  createSegment,
  buildTranscript,
  shouldTriggerOfflinePass,
  appendSamples,
  segmentDurationSec,
  samplesToWav,
  uint8ToBase64,
  Segment,
  SAMPLE_RATE,
  MIN_AUDIO_SAMPLES,
  MAX_NO_PASS_MS,
} from "./segment-manager";
import {
  createState,
  enqueue,
  dequeue,
  writebackTarget,
  onRotate,
  QueueEntry,
} from "./progressive-pass-state";

export interface HybridUpdate {
  text: string;
  source: "streaming" | "offline";
  offlineRunning: boolean;
}

export interface HybridHandle {
  stop: () => Promise<void>;
}

/**
 * Write a segment's audio samples to a temp WAV file.
 * Returns the file path. Caller must delete after use.
 */
async function writeSegmentToWav(seg: Segment): Promise<string> {
  const wavPath = `${FileSystem.cacheDirectory}vox-offline-${seg.index}-${Date.now()}.wav`;
  const wavBytes = samplesToWav(seg.audioSamples);
  const base64 = uint8ToBase64(wavBytes);
  await FileSystem.writeAsStringAsync(wavPath, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return wavPath;
}

export async function startHybridTranscription(
  onUpdate: (u: HybridUpdate) => void,
  onError: (msg: string) => void
): Promise<HybridHandle> {
  const engine = getSherpaEngine();
  if (!engine) throw new Error("Sherpa engine not initialized");

  // State
  const finishedSegments: Segment[] = [];
  let currentSegment = createSegment(0);
  let lastPassTime = 0;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // Offline pass serialization — queue + writeback (see progressive-pass-state.ts).
  // inFlightPromise is tracked here only so stop() can await drain.
  const passState = createState();
  let inFlightPromise: Promise<void> | null = null;

  function emit(source: "streaming" | "offline") {
    if (stopped) return;
    onUpdate({
      text: buildTranscript(finishedSegments, currentSegment),
      source,
      offlineRunning: inFlightPromise !== null,
    });
  }

  function describeEntry(entry: QueueEntry): string {
    return entry.kind === "progressive"
      ? `progressive, mark=${entry.mark}s`
      : "endpoint";
  }

  async function doOfflinePass(entry: QueueEntry): Promise<string | null> {
    const seg = entry.seg;
    if (!isWhisperReady()) return null;
    if (seg.audioSamples.length < MIN_AUDIO_SAMPLES) return null;

    const durationS = segmentDurationSec(seg).toFixed(1);
    console.log(
      `[vox] Offline pass #${seg.index} (${describeEntry(entry)}): ${durationS}s of audio, ${seg.audioSamples.length} samples`
    );

    let wavPath: string | null = null;
    try {
      wavPath = await writeSegmentToWav(seg);
      console.log(`[vox] WAV written: ${wavPath}`);

      let rawText = await transcribeFileOffline(wavPath);
      console.log(`[vox] Offline raw #${seg.index}: "${rawText.slice(0, 80)}"`);

      // If empty, the engine may be in a bad state. Reset and retry once.
      if (!rawText.trim()) {
        console.log(`[vox] Empty result, resetting engine and retrying...`);
        await resetOfflineEngine();
        rawText = await transcribeFileOffline(wavPath);
        console.log(`[vox] Retry raw #${seg.index}: "${rawText.slice(0, 80)}"`);
      }

      const corrected = applyCorrections(rawText.toLowerCase().trim());
      const result = corrected.text.trim();

      if (result) {
        console.log(`[vox] Offline #${seg.index}: "${result.slice(0, 80)}"`);
        return result;
      }
      console.log(`[vox] Offline #${seg.index}: empty after retry, keeping streaming text`);
      return null;
    } catch (e: any) {
      console.warn(`[vox] Offline pass error: ${e?.message ?? e}`);
      return null;
    } finally {
      lastPassTime = Date.now();
      if (wavPath) {
        try { await FileSystem.deleteAsync(wavPath, { idempotent: true }); } catch {}
      }
    }
  }

  function applyResult(entry: QueueEntry, result: string | null) {
    if (result == null) return;
    const target = writebackTarget(entry.seg, currentSegment.index, finishedSegments);
    if (target.target === "current") {
      currentSegment.offlineText = result;
    } else if (target.target === "finished") {
      finishedSegments[target.i].offlineText = result;
    }
    // discard otherwise (a newer pass already won, or segment cleaned up)
  }

  function runEntry(entry: QueueEntry) {
    passState.inFlight = entry;
    inFlightPromise = doOfflinePass(entry)
      .then((result) => {
        applyResult(entry, result);
        emit("offline");
      })
      .finally(() => {
        passState.inFlight = null;
        inFlightPromise = null;
        const next = dequeue(passState);
        if (next) runEntry(next);
      });
  }

  function scheduleOfflinePass(entry: QueueEntry) {
    if (!isWhisperReady()) return;
    if (entry.seg.audioSamples.length < MIN_AUDIO_SAMPLES) return;

    if (passState.inFlight) {
      enqueue(passState, entry);
      return;
    }
    runEntry(entry);
  }

  function tryOfflinePass() {
    if (stopped) return;
    if (!shouldTriggerOfflinePass(currentSegment, lastPassTime, Date.now())) return;

    const toProcess = currentSegment;
    finishedSegments.push(toProcess);
    currentSegment = createSegment(toProcess.index + 1);
    onRotate(passState);

    scheduleOfflinePass({ kind: "endpoint", seg: toProcess });
    resetMaxTimer();
  }

  function resetMaxTimer() {
    if (maxTimer) clearTimeout(maxTimer);
    if (stopped) return;
    maxTimer = setTimeout(() => tryOfflinePass(), MAX_NO_PASS_MS);
  }

  // Create STT stream and PCM capture
  const sttStream: SttStream = await engine.createStream();
  const pcm: PcmLiveStreamHandle = createPcmLiveStream({ sampleRate: SAMPLE_RATE });

  pcm.onError((msg: string) => onError(`Audio: ${msg}`));

  // Serialize access to sttStream. PCM callbacks fire every ~20-100ms;
  // if processAudioChunk takes longer than that interval, the next callback
  // would call into the native stream concurrently, causing a native crash.
  let processing = false;
  const pendingChunks: { samples: Float32Array; sampleRate: number }[] = [];

  async function processNextChunk() {
    if (processing || stopped) return;
    const next = pendingChunks.shift();
    if (!next) return;

    processing = true;
    try {
      const { result, isEndpoint } = await sttStream.processAudioChunk(
        Array.from(next.samples),
        next.sampleRate
      );

      if (isEndpoint) {
        // Reset FIRST, then rotate segment. This ensures:
        // 1. The stream is reset before any more chunks are processed
        // 2. Queued chunks after this point feed the new (empty) stream
        // 3. No stale text from the old stream leaks into the new segment
        await sttStream.reset();

        // Finalize the current segment's streaming text before rotating
        if (result.text) {
          const corrected = applyCorrections(result.text.toLowerCase().trim());
          currentSegment.streamingText = corrected.text.trim();
        }

        tryOfflinePass();

        // Flush any queued chunks that arrived during reset — they contain
        // audio that was already buffered into the OLD segment. Feeding them
        // into the freshly-reset stream would produce duplicate text.
        pendingChunks.length = 0;
      } else if (result.text) {
        const corrected = applyCorrections(result.text.toLowerCase().trim());
        currentSegment.streamingText = corrected.text.trim();
        emit("streaming");
      }
    } catch (e: any) {
      onError(e?.message ?? String(e));
    } finally {
      processing = false;
      if (pendingChunks.length > 0) processNextChunk();
    }
  }

  const unsubData = pcm.onData(async (samples: Float32Array, sampleRate: number) => {
    if (stopped) return;

    // 1. Buffer audio for offline pass (sync, always runs)
    appendSamples(currentSegment, samples);

    // 2. Queue for sherpa streaming (serialized to prevent concurrent native calls)
    pendingChunks.push({ samples, sampleRate });
    processNextChunk();
  });

  await pcm.start();
  resetMaxTimer();
  lastPassTime = Date.now();

  return {
    stop: async () => {
      stopped = true;
      if (maxTimer) clearTimeout(maxTimer);

      await pcm.stop();
      unsubData();

      // Drain the offline-pass queue. inFlightPromise resolves only after
      // the .finally hook runs, which may schedule the next entry — so loop
      // until both inFlight and queue are empty.
      while (passState.inFlight || passState.queue.length > 0) {
        if (inFlightPromise) {
          console.log("[vox] Waiting for in-progress offline pass...");
          await inFlightPromise;
        }
      }

      // Final offline pass on remaining audio in the still-open segment.
      // Push to finishedSegments first so applyResult can route the result
      // there via writebackTarget("finished").
      if (currentSegment.audioSamples.length >= MIN_AUDIO_SAMPLES && isWhisperReady()) {
        const finalSeg = currentSegment;
        finishedSegments.push(finalSeg);
        currentSegment = createSegment(finalSeg.index + 1);
        onRotate(passState);
        scheduleOfflinePass({ kind: "endpoint", seg: finalSeg });
        while (passState.inFlight || passState.queue.length > 0) {
          if (inFlightPromise) await inFlightPromise;
        }
      } else if (currentSegment.streamingText.trim()) {
        const finalSeg = currentSegment;
        finishedSegments.push(finalSeg);
        currentSegment = createSegment(finalSeg.index + 1);
      }

      // Emit final transcript
      stopped = false;
      emit("offline");
      stopped = true;

      try { await sttStream.release(); } catch {}
    },
  };
}
