/**
 * Sherpa-ONNX streaming STT engine for Android.
 *
 * Uses the French Kroko streaming zipformer model (~55MB) with the
 * PCM live stream API for real-time dictation. Runs fast enough for
 * real-time on any modern Android phone.
 *
 * Architecture:
 *   mic -> PCM live stream (16kHz mono) -> streaming STT engine
 *     -> partial results every ~200ms -> medical corrector -> display
 */

import {
  ModelCategory,
  ensureModelByCategory,
  refreshModelsByCategory,
} from "react-native-sherpa-onnx/download";
import type { DownloadProgress } from "react-native-sherpa-onnx/download";
import { createStreamingSTT } from "react-native-sherpa-onnx/stt";
import { createPcmLiveStream } from "react-native-sherpa-onnx/audio";
import { fileModelPath } from "react-native-sherpa-onnx";
import type {
  StreamingSttEngine,
  SttStream,
} from "react-native-sherpa-onnx/stt";
import type { PcmLiveStreamHandle } from "react-native-sherpa-onnx/audio";

// French streaming model for real-time preview.
// Only the 2023 zipformer works with react-native-sherpa-onnx 0.4.2.
// Newer models crash on metadata parsing (attention_dims / window_size).
const FRENCH_MODEL_ID = "sherpa-onnx-streaming-zipformer-fr-2023-04-14-mobile";

export interface SherpaDownloadProgress {
  phase: string;
  percent: number;
}

export interface SherpaRealtimeUpdate {
  text: string;
  isEndpoint: boolean;
}

export interface SherpaRealtimeHandle {
  stop: () => Promise<void>;
}

let engine: StreamingSttEngine | null = null;

/**
 * Ensure the French model is downloaded and extracted.
 * Returns the local filesystem path to the model directory.
 */
export async function ensureFrenchModel(
  onProgress?: (p: SherpaDownloadProgress) => void
): Promise<string> {
  // Refresh the model registry from GitHub releases so the ID is known
  await refreshModelsByCategory(ModelCategory.Stt, { forceRefresh: false });

  const result = await ensureModelByCategory(ModelCategory.Stt, FRENCH_MODEL_ID, {
    onProgress: (p: DownloadProgress) => {
      if (onProgress) {
        onProgress({ phase: p.phase ?? "download", percent: p.percent ?? 0 });
      }
    },
  });
  return result.localPath;
}

/**
 * Initialize the streaming STT engine with the French model.
 */
export async function initSherpaEngine(modelPath: string): Promise<void> {
  if (engine) {
    await engine.destroy();
    engine = null;
  }

  console.log(`[vox] initSherpaEngine: modelPath=${modelPath}`);

  try {
    engine = await createStreamingSTT({
      modelPath: fileModelPath(modelPath),
      modelType: "auto",  // let the SDK detect model layout
      numThreads: 4,
      enableEndpoint: true,
      debug: true,
      endpointConfig: {
        rule1: { mustContainNonSilence: false, minTrailingSilence: 2.4, minUtteranceLength: 0 },
        rule2: { mustContainNonSilence: true, minTrailingSilence: 1.2, minUtteranceLength: 0 },
        rule3: { mustContainNonSilence: false, minTrailingSilence: 0, minUtteranceLength: 20 },
      },
    });
    console.log("[vox] Sherpa engine initialized successfully");
  } catch (e: any) {
    console.error(`[vox] Sherpa engine init failed: ${e?.message ?? e}`);
    engine = null;
    throw e;
  }
}

export function isSherpaReady(): boolean {
  return engine !== null;
}

/**
 * Get the underlying engine for advanced use (e.g., hybrid-engine).
 */
export function getSherpaEngine(): StreamingSttEngine | null {
  return engine;
}

/**
 * Start a real-time dictation session.
 *
 * Creates a PCM live stream (mic at 16kHz) and a streaming STT stream.
 * Partial results are delivered via onUpdate as the user speaks.
 */
export async function startSherpaRealtime(
  onUpdate: (u: SherpaRealtimeUpdate) => void,
  onError: (msg: string) => void
): Promise<SherpaRealtimeHandle> {
  if (!engine) {
    throw new Error("Sherpa engine not initialized. Call initSherpaEngine first.");
  }

  const stream: SttStream = await engine.createStream();
  const pcm: PcmLiveStreamHandle = createPcmLiveStream({ sampleRate: 16000 });

  pcm.onError((msg: string) => onError(`Audio: ${msg}`));

  const unsubData = pcm.onData(async (samples: Float32Array, sampleRate: number) => {
    try {
      const { result, isEndpoint } = await stream.processAudioChunk(
        Array.from(samples),
        sampleRate
      );
      if (result.text) {
        onUpdate({ text: result.text, isEndpoint });
      }
      if (isEndpoint) {
        await stream.reset();
      }
    } catch (e: any) {
      onError(e?.message ?? String(e));
    }
  });

  await pcm.start();

  return {
    stop: async () => {
      await pcm.stop();
      unsubData();
      await stream.inputFinished();
      // Get final result
      try {
        const finalResult = await stream.getResult();
        if (finalResult.text) {
          onUpdate({ text: finalResult.text, isEndpoint: true });
        }
      } catch {
        // Ignore errors on final result, stream may already be done
      }
      await stream.release();
    },
  };
}

/**
 * Release the engine when no longer needed.
 */
export async function destroySherpaEngine(): Promise<void> {
  if (engine) {
    await engine.destroy();
    engine = null;
  }
}
