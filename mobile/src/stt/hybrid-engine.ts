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

  const unsubData = pcm.onData(async (samples: Float32Array, sampleRate: number) => {
    if (stopped) return;

    // 1. Buffer audio for offline pass
    appendSamples(currentSegment, samples);

    // 2. Feed to sherpa streaming for real-time text
    try {
      const { result, isEndpoint } = await sttStream.processAudioChunk(
        Array.from(samples),
        sampleRate
      );

      if (result.text) {
        const corrected = applyCorrections(result.text.toLowerCase().trim());
        currentSegment.streamingText = corrected.text.trim();
        emit("streaming");
      }

      if (isEndpoint) {
        await sttStream.reset();
        tryOfflinePass();
      }
    } catch (e: any) {
      onError(e?.message ?? String(e));
    }
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

      // Drain pending queue
      if (pendingSegment) {
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
