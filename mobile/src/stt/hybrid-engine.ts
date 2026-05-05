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

  // Offline pass serialization
  let offlinePromise: Promise<void> | null = null;
  let pendingSegment: Segment | null = null;

  function emit(source: "streaming" | "offline") {
    if (stopped) return;
    onUpdate({
      text: buildTranscript(finishedSegments, currentSegment),
      source,
      offlineRunning: offlinePromise !== null,
    });
  }

  async function doOfflinePass(seg: Segment): Promise<void> {
    if (!isWhisperReady()) return;
    if (seg.audioSamples.length < MIN_AUDIO_SAMPLES) return;

    const durationS = segmentDurationSec(seg).toFixed(1);
    console.log(`[vox] Offline pass #${seg.index}: ${durationS}s of audio, ${seg.audioSamples.length} samples`);

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
        seg.offlineText = result;
        console.log(`[vox] Offline #${seg.index}: "${result.slice(0, 80)}"`);
      } else {
        console.log(`[vox] Offline #${seg.index}: empty after retry, keeping streaming text`);
      }
    } catch (e: any) {
      console.warn(`[vox] Offline pass error: ${e?.message ?? e}`);
    } finally {
      lastPassTime = Date.now();
      if (wavPath) {
        try { await FileSystem.deleteAsync(wavPath, { idempotent: true }); } catch {}
      }
    }
  }

  function scheduleOfflinePass(seg: Segment) {
    if (!isWhisperReady()) return;
    if (seg.audioSamples.length < MIN_AUDIO_SAMPLES) return;

    if (offlinePromise) {
      pendingSegment = seg;
      return;
    }

    offlinePromise = doOfflinePass(seg)
      .then(() => emit("offline"))
      .finally(() => {
        offlinePromise = null;
        if (pendingSegment) {
          const next = pendingSegment;
          pendingSegment = null;
          scheduleOfflinePass(next);
        }
      });
  }

  function tryOfflinePass() {
    if (stopped) return;
    if (!shouldTriggerOfflinePass(currentSegment, lastPassTime, Date.now())) return;

    const toProcess = currentSegment;
    finishedSegments.push(toProcess);
    currentSegment = createSegment(toProcess.index + 1);

    scheduleOfflinePass(toProcess);
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

      // Wait for any in-progress offline pass
      if (offlinePromise) {
        console.log("[vox] Waiting for in-progress offline pass...");
        await offlinePromise;
      }

      // Final offline pass on remaining audio
      if (currentSegment.audioSamples.length >= MIN_AUDIO_SAMPLES && isWhisperReady()) {
        finishedSegments.push(currentSegment);
        await doOfflinePass(currentSegment);
      } else if (currentSegment.streamingText.trim()) {
        finishedSegments.push(currentSegment);
      }

      // Replace currentSegment with an empty one so buildTranscript
      // doesn't double-count the segment we just pushed to finishedSegments.
      currentSegment = createSegment(currentSegment.index + 1);

      // Drain pending queue
      if (pendingSegment) {
        finishedSegments.push(pendingSegment);
        await doOfflinePass(pendingSegment);
        pendingSegment = null;
      }

      // Emit final transcript
      stopped = false;
      emit("offline");
      stopped = true;

      try { await sttStream.release(); } catch {}
    },
  };
}
