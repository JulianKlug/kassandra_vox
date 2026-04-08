/**
 * Model download and storage management.
 *
 * Downloads the Whisper GGML model on first launch and caches it in the
 * app's documents directory. The model never leaves the device.
 */

import * as FileSystem from "expo-file-system/legacy";

// Model variants
export type ModelVariant = "large-v3" | "medium";

interface ModelInfo {
  url: string;
  filename: string;
  sizeBytes: number;
  sizeLabel: string;
}

const MODELS: Record<ModelVariant, ModelInfo> = {
  "large-v3": {
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
    filename: "ggml-large-v3.bin",
    sizeBytes: 3_094_623_232, // ~2.9 GB
    sizeLabel: "2.9 GB",
  },
  medium: {
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
    filename: "ggml-medium.bin",
    sizeBytes: 1_533_763_968, // ~1.5 GB
    sizeLabel: "1.5 GB",
  },
};

const MODELS_DIR = `${FileSystem.documentDirectory}models/`;

export interface DownloadProgress {
  bytesWritten: number;
  totalBytes: number;
  percent: number;
}

export async function ensureModelsDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(MODELS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(MODELS_DIR, { intermediates: true });
  }
}

export function getModelPath(variant: ModelVariant): string {
  return `${MODELS_DIR}${MODELS[variant].filename}`;
}

export function getModelInfo(variant: ModelVariant): ModelInfo {
  return MODELS[variant];
}

export async function isModelDownloaded(variant: ModelVariant): Promise<boolean> {
  const path = getModelPath(variant);
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) return false;
  // Sanity check: file should be at least 90% of expected size
  const expectedMin = MODELS[variant].sizeBytes * 0.9;
  const size = (info as { size?: number }).size ?? 0;
  return size >= expectedMin;
}

export async function downloadModel(
  variant: ModelVariant,
  onProgress?: (p: DownloadProgress) => void
): Promise<string> {
  await ensureModelsDir();
  const model = MODELS[variant];
  const dest = getModelPath(variant);

  const downloadResumable = FileSystem.createDownloadResumable(
    model.url,
    dest,
    {},
    (status) => {
      if (onProgress) {
        const total = status.totalBytesExpectedToWrite || model.sizeBytes;
        onProgress({
          bytesWritten: status.totalBytesWritten,
          totalBytes: total,
          percent: total > 0 ? status.totalBytesWritten / total : 0,
        });
      }
    }
  );

  const result = await downloadResumable.downloadAsync();
  if (!result) {
    throw new Error("Model download failed");
  }
  return result.uri;
}

export async function deleteModel(variant: ModelVariant): Promise<void> {
  const path = getModelPath(variant);
  const info = await FileSystem.getInfoAsync(path);
  if (info.exists) {
    await FileSystem.deleteAsync(path);
  }
}
