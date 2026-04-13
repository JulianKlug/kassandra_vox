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
 *   - Always on stop
 *   - One pass at a time, skip if busy
 */

import * as FileSystem from "expo-file-system/legacy";
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
  let offlineRunning = false;
  let lastPassTime = 0;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // Build full transcript from all segments
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
    onUpdate({ text: buildTranscript(), source, offlineRunning });
  }

  // Write PCM samples to WAV file
  async function writeWav(path: string, samples: number[]): Promise<void> {
    const numSamples = samples.length;
    const dataSize = numSamples * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);

    // Header
    const enc = (s: string, off: number) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    enc("RIFF", 0);
    view.setUint32(4, 36 + dataSize, true);
    enc("WAVE", 8);
    enc("fmt ", 12);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    enc("data", 36);
    view.setUint32(40, dataSize, true);

    // PCM data (float -> int16)
    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
      offset += 2;
    }

    // Write via base64 (expo-file-system limitation)
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      for (let j = 0; j < chunk.length; j++) {
        binary += String.fromCharCode(chunk[j]);
      }
    }
    await FileSystem.writeAsStringAsync(path, btoa(binary), {
      encoding: FileSystem.EncodingType.Base64,
    });
  }

  // Run offline pass on a segment
  async function runOfflinePass(seg: Segment): Promise<void> {
    if (!isWhisperReady()) return;
    if (seg.audioSamples.length < MIN_AUDIO_SAMPLES) return;

    offlineRunning = true;
    emit("streaming");

    try {
      const wavPath = `${FileSystem.cacheDirectory}vox-offline-${seg.index}.wav`;
      await writeWav(wavPath, seg.audioSamples);
      const rawText = await transcribeOffline(wavPath);
      const corrected = applyCorrections(rawText.toLowerCase().trim());
      seg.offlineText = corrected.text.trim();
      try { await FileSystem.deleteAsync(wavPath, { idempotent: true }); } catch {}
      console.log(`[vox] Offline #${seg.index}: "${seg.offlineText?.slice(0, 80)}"`);
    } catch (e: any) {
      console.warn(`[vox] Offline pass failed: ${e?.message ?? e}`);
    } finally {
      offlineRunning = false;
      lastPassTime = Date.now();
      emit("offline");
    }
  }

  function tryOfflinePass() {
    if (offlineRunning || stopped) return;
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

    runOfflinePass(toProcess); // fire and forget
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

    // 1. Feed to audio buffer for offline pass
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

      // Final offline pass on remaining audio
      if (currentSegment.audioSamples.length >= MIN_AUDIO_SAMPLES && isWhisperReady()) {
        finishedSegments.push(currentSegment);
        await runOfflinePass(currentSegment);
      } else if (currentSegment.streamingText.trim()) {
        // Not enough audio for offline, keep streaming text
        finishedSegments.push(currentSegment);
      }

      emit("offline");

      try { await sttStream.release(); } catch {}
    },
  };
}
