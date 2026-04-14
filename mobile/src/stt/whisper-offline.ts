/**
 * Whisper offline second-pass engine via sherpa-onnx.
 *
 * Uses sherpa-onnx's createSTT() (onnxruntime) instead of whisper.rn
 * (whisper.cpp). On Android, onnxruntime can use NNAPI for hardware
 * acceleration, giving up to 50x speed improvement over CPU-only
 * whisper.cpp. This makes the offline pass feasible on the S22.
 *
 * Model: whisper-distil-large-v3.5 (504MB) - distilled from large-v3,
 * multilingual including French, smallest distilled variant.
 */

import {
  ModelCategory,
  ensureModelByCategory,
  refreshModelsByCategory,
} from "react-native-sherpa-onnx/download";
import type { DownloadProgress } from "react-native-sherpa-onnx/download";
import { createSTT } from "react-native-sherpa-onnx/stt";
import { fileModelPath } from "react-native-sherpa-onnx";
import type { SttEngine } from "react-native-sherpa-onnx/stt";

// Models tried:
// - distil-large-v3.5 (504MB): translates to English despite language:"fr" (likely English-only model)
// - whisper-turbo (538MB): whisper-large-v3-turbo, guaranteed multilingual
const WHISPER_MODEL_ID = "sherpa-onnx-whisper-turbo";

export interface WhisperDownloadProgress {
  percent: number;
  phase: string;
}

let sttEngine: SttEngine | null = null;

export async function isWhisperModelDownloaded(): Promise<boolean> {
  // The download manager tracks this internally
  // We just check if the engine is initialized
  return sttEngine !== null;
}

export async function downloadWhisperModel(
  onProgress?: (p: WhisperDownloadProgress) => void
): Promise<string> {
  await refreshModelsByCategory(ModelCategory.Stt, { forceRefresh: false });

  const result = await ensureModelByCategory(ModelCategory.Stt, WHISPER_MODEL_ID, {
    onProgress: (p: DownloadProgress) => {
      if (onProgress) {
        onProgress({ percent: p.percent ?? 0, phase: p.phase ?? "download" });
      }
    },
  });
  return result.localPath;
}

export async function initWhisperOffline(): Promise<void> {
  if (sttEngine) return;

  const modelPath = await downloadWhisperModel((p) => {
    console.log(`[vox] Whisper download: ${Math.round(p.percent)}%`);
  });

  console.log(`[vox] Loading whisper offline from ${modelPath}`);

  sttEngine = await createSTT({
    modelPath: fileModelPath(modelPath),
    modelType: "whisper",
    numThreads: 4,
    modelOptions: {
      whisper: { language: "fr", task: "transcribe" },
    },
    debug: true,
  });

  console.log("[vox] Whisper offline engine ready (sherpa-onnx/onnxruntime)");
}

export function isWhisperReady(): boolean {
  return sttEngine !== null;
}

/**
 * Transcribe audio samples with whisper via sherpa-onnx (onnxruntime).
 * Takes float32 PCM samples in [-1, 1] at 16kHz.
 */
export async function transcribeOffline(samples: number[], sampleRate: number = 16000): Promise<string> {
  if (!sttEngine) throw new Error("Whisper offline not initialized");

  const result = await sttEngine.transcribeSamples(samples, sampleRate);
  return result.text;
}

/**
 * Transcribe a WAV file with whisper via sherpa-onnx (onnxruntime).
 */
export async function transcribeFileOffline(wavPath: string): Promise<string> {
  if (!sttEngine) throw new Error("Whisper offline not initialized");

  const result = await sttEngine.transcribeFile(wavPath);
  return result.text;
}

export async function releaseWhisperOffline(): Promise<void> {
  if (sttEngine) {
    await sttEngine.destroy();
    sttEngine = null;
  }
}
