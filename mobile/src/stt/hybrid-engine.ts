/**
 * Hybrid STT engine: zipformer streaming + whisper offline second-pass.
 *
 * Single PCM audio stream feeds BOTH:
 *   1. Sherpa zipformer (real-time rough text)
 *   2. Audio buffer (accumulated for offline whisper pass)
 *
 * Timing for offline passes:
 *   - On each speech endpoint (pause detected by zipformer)
 *   - Minimum 5s between passes
 *   - Minimum 3s of accumulated audio
 *   - Maximum 30s without a pass
 *   - Always on stop (waits for any in-progress pass first)
 *   - One pass at a time, queues next segment if busy
 */

import { createPcmLiveStream } from "react-native-sherpa-onnx/audio";
import type { PcmLiveStreamHandle } from "react-native-sherpa-onnx/audio";
import type { SttStream } from "react-native-sherpa-onnx/stt";
import { getSherpaEngine } from "./sherpa-streaming";
import { transcribeOffline, isWhisperReady } from "./whisper-offline";
import { applyCorrections } from "../pipeline/correct";

const MIN_PASS_INTERVAL_MS = 5_000;
const MIN_AUDIO_SAMPLES = 16_000 * 3; // 3 seconds at 16kHz
const MAX_NO_PASS_MS = 30_000;
const SAMPLE_RATE = 16000;

export interface HybridUpdate {
  text: string;
  source: "streaming" | "offline";
  offlineRunning: boolean;
}

export interface HybridHandle {
  stop: () => Promise<void>;
}

interface Segment {
  index: number;
  streamingText: string;
  offlineText: string | null;
  audioSamples: number[];
}

export async function startHybridTranscription(
  onUpdate: (u: HybridUpdate) => void,
  onError: (msg: string) => void
): Promise<HybridHandle> {
  const engine = getSherpaEngine();
  if (!engine) throw new Error("Sherpa engine not initialized");

  // State
  const finishedSegments: Segment[] = [];
  let currentSegment: Segment = {
    index: 0, streamingText: "", offlineText: null, audioSamples: [],
  };
  let lastPassTime = 0;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // Offline pass serialization: only one whisper transcription at a time.
  // offlinePromise tracks the currently running pass so we can await it.
  let offlinePromise: Promise<void> | null = null;
  let pendingSegment: Segment | null = null;

  function buildTranscript(): string {
    const parts: string[] = [];
    for (const seg of finishedSegments) {
      const t = seg.offlineText ?? seg.streamingText;
      if (t.trim()) parts.push(t.trim());
    }
    const current = currentSegment.streamingText;
    if (current.trim()) parts.push(current.trim());
    return parts.join(". ");
  }

  function emit(source: "streaming" | "offline") {
    if (stopped) return;
    onUpdate({ text: buildTranscript(), source, offlineRunning: offlinePromise !== null });
  }

  // The actual offline transcription work. Caller must ensure
  // no other pass is running (via offlinePromise guard).
  async function doOfflinePass(seg: Segment): Promise<void> {
    if (!isWhisperReady()) return;
    if (seg.audioSamples.length < MIN_AUDIO_SAMPLES) return;

    const durationS = (seg.audioSamples.length / SAMPLE_RATE).toFixed(1);
    console.log(`[vox] Offline pass #${seg.index}: ${durationS}s of audio`);

    try {
      // Pass float32 PCM samples directly to sherpa-onnx (no WAV file needed)
      const rawText = await transcribeOffline(seg.audioSamples, SAMPLE_RATE);
      const corrected = applyCorrections(rawText.toLowerCase().trim());
      seg.offlineText = corrected.text.trim();
      console.log(`[vox] Offline #${seg.index}: "${seg.offlineText?.slice(0, 80)}"`);
    } catch (e: any) {
      console.warn(`[vox] Offline pass error: ${e?.message ?? e}`);
    } finally {
      lastPassTime = Date.now();
    }
  }

  // Schedule an offline pass on a segment, respecting the one-at-a-time rule.
  function scheduleOfflinePass(seg: Segment) {
    if (!isWhisperReady()) return;
    if (seg.audioSamples.length < MIN_AUDIO_SAMPLES) return;

    if (offlinePromise) {
      // Busy. Queue this segment (replace any previously queued).
      pendingSegment = seg;
      return;
    }

    // Start the pass
    offlinePromise = doOfflinePass(seg)
      .then(() => {
        emit("offline");
      })
      .finally(() => {
        offlinePromise = null;

        // Process queued segment if any
        if (pendingSegment) {
          const next = pendingSegment;
          pendingSegment = null;
          scheduleOfflinePass(next);
        }
      });
  }

  function tryOfflinePass() {
    if (stopped) return;
    if (Date.now() - lastPassTime < MIN_PASS_INTERVAL_MS) return;
    if (currentSegment.audioSamples.length < MIN_AUDIO_SAMPLES) return;

    // Move current segment to finished and start a new one
    const toProcess = currentSegment;
    finishedSegments.push(toProcess);
    currentSegment = {
      index: toProcess.index + 1,
      streamingText: "",
      offlineText: null,
      audioSamples: [],
    };

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
    for (let i = 0; i < samples.length; i++) {
      currentSegment.audioSamples.push(samples[i]);
    }

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

      // Wait for any in-progress offline pass to finish
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

      // Process any pending segment that was queued
      if (pendingSegment) {
        await doOfflinePass(pendingSegment);
        pendingSegment = null;
      }

      // Emit final transcript
      stopped = false; // temporarily allow emit
      emit("offline");
      stopped = true;

      try { await sttStream.release(); } catch {}
    },
  };
}
