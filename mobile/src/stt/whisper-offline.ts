/**
 * Offline second-pass STT engine via sherpa-onnx.
 *
 * Uses sherpa-onnx's createSTT() (onnxruntime) for hardware-accelerated
 * inference on Android (NNAPI/XNNPACK).
 *
 * Model selection strategy (tried in order):
 * 1. NVidia Canary-180M-Flash (147MB int8, 4.75% MLS FR WER, 182M params)
 * 2. NVidia stt_fr_conformer_ctc_large (120MB, CTC = fastest, FR-specific)
 * 3. bofenghuang whisper-large-v3-french-distil-dec2 (needs ONNX conversion)
 *
 * Previous models tried:
 * - whisper-distil-large-v3.5: translates to English (English-only model)
 * - whisper-turbo: translates to English despite language:"fr"
 * - whisper.rn (any model): CPU-only on Android, too slow (30-60s for 30s audio)
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

// NVidia Canary-180M-Flash: 182M params, 4.75% WER on MLS French, int8 quantized
// Pre-built in sherpa-onnx, supports EN/ES/DE/FR
const OFFLINE_MODEL_ID = "sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8";

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

export async function downloadOfflineModel(
  onProgress?: (p: WhisperDownloadProgress) => void
): Promise<string> {
  await refreshModelsByCategory(ModelCategory.Stt, { forceRefresh: false });

  const result = await ensureModelByCategory(ModelCategory.Stt, OFFLINE_MODEL_ID, {
    onProgress: (p: DownloadProgress) => {
      if (onProgress) {
        onProgress({ percent: p.percent ?? 0, phase: p.phase ?? "download" });
      }
    },
  });
  return result.localPath;
}

export async function initOfflineEngine(): Promise<void> {
  if (sttEngine) return;

  const modelPath = await downloadOfflineModel((p) => {
    console.log(`[vox] Offline model download: ${Math.round(p.percent)}%`);
  });

  console.log(`[vox] Loading Canary-180M-Flash from ${modelPath}`);

  sttEngine = await createSTT({
    modelPath: fileModelPath(modelPath),
    modelType: "canary",
    numThreads: 4,
    modelOptions: {
      canary: { srcLang: "fr", tgtLang: "fr", usePnc: true },
    },
    debug: true,
  });

  console.log("[vox] Canary-180M-Flash offline engine ready");
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
 * Transcribe a WAV file via sherpa-onnx (onnxruntime).
 * Strips file:// URI prefix since sherpa-onnx expects plain filesystem paths.
 */
export async function transcribeFileOffline(wavPath: string): Promise<string> {
  if (!sttEngine) throw new Error("Offline engine not initialized");

  // expo-file-system uses file:// URIs, sherpa-onnx expects plain paths
  const plainPath = wavPath.replace(/^file:\/\//, "");
  const result = await sttEngine.transcribeFile(plainPath);
  return result.text;
}

export async function releaseOfflineEngine(): Promise<void> {
  if (sttEngine) {
    await sttEngine.destroy();
    sttEngine = null;
  }
}
