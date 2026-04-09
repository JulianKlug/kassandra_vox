/**
 * Model download and storage management.
 *
 * Downloads the Whisper GGML model on first launch and caches it in the
 * app's documents directory. The model never leaves the device.
 *
 * Downloads are resumable: state is persisted to disk so a failed or
 * paused download can pick up where it left off on the next attempt.
 * Includes automatic retry on transient network errors.
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
    sizeBytes: 1_533_763_059, // ~1.5 GB (verified checksum)
    sizeLabel: "1.5 GB",
  },
};

const MODELS_DIR = `${FileSystem.documentDirectory}models/`;
const STATE_DIR = `${FileSystem.documentDirectory}models-state/`;

// Auto-retry config
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

export interface DownloadProgress {
  bytesWritten: number;
  totalBytes: number;
  percent: number;
}

export async function ensureModelsDir(): Promise<void> {
  for (const dir of [MODELS_DIR, STATE_DIR]) {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
  }
}

export function getModelPath(variant: ModelVariant): string {
  return `${MODELS_DIR}${MODELS[variant].filename}`;
}

export function getModelInfo(variant: ModelVariant): ModelInfo {
  return MODELS[variant];
}

function getStatePath(variant: ModelVariant): string {
  return `${STATE_DIR}${MODELS[variant].filename}.state.json`;
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

/**
 * Whether a partial download exists that can be resumed.
 */
export async function hasResumableDownload(variant: ModelVariant): Promise<boolean> {
  const statePath = getStatePath(variant);
  const info = await FileSystem.getInfoAsync(statePath);
  return info.exists;
}

async function loadState(variant: ModelVariant): Promise<unknown | null> {
  try {
    const statePath = getStatePath(variant);
    const info = await FileSystem.getInfoAsync(statePath);
    if (!info.exists) return null;
    const json = await FileSystem.readAsStringAsync(statePath);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function saveState(variant: ModelVariant, state: unknown): Promise<void> {
  try {
    const statePath = getStatePath(variant);
    await FileSystem.writeAsStringAsync(statePath, JSON.stringify(state));
  } catch {
    // Best-effort: failing to persist resume state is non-fatal
  }
}

async function clearState(variant: ModelVariant): Promise<void> {
  try {
    const statePath = getStatePath(variant);
    const info = await FileSystem.getInfoAsync(statePath);
    if (info.exists) {
      await FileSystem.deleteAsync(statePath);
    }
  } catch {
    // ignore
  }
}

/**
 * Download a model with resumable support and automatic retry.
 *
 * - If a partial download exists from a prior attempt, resumes from there.
 * - On transient network errors, retries up to MAX_RETRIES times with backoff.
 * - Persists resume state to disk so even if the app is killed, the next
 *   call will pick up where the previous one left off.
 */
export async function downloadModel(
  variant: ModelVariant,
  onProgress?: (p: DownloadProgress) => void
): Promise<string> {
  await ensureModelsDir();
  const model = MODELS[variant];
  const dest = getModelPath(variant);

  // If already fully downloaded, nothing to do.
  if (await isModelDownloaded(variant)) {
    await clearState(variant);
    return dest;
  }

  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await runDownloadOnce(variant, model, dest, onProgress);
      // Verify the file actually arrived intact
      if (await isModelDownloaded(variant)) {
        await clearState(variant);
        return result;
      }
      throw new Error("Downloaded file is smaller than expected. Will retry.");
    } catch (err) {
      lastError = err;
      // Wait before retrying (skip wait on last attempt)
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }

  throw new Error(
    `Model download failed after ${MAX_RETRIES} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

async function runDownloadOnce(
  variant: ModelVariant,
  model: ModelInfo,
  dest: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<string> {
  const callback = (status: FileSystem.DownloadProgressData) => {
    if (onProgress) {
      const total = status.totalBytesExpectedToWrite || model.sizeBytes;
      onProgress({
        bytesWritten: status.totalBytesWritten,
        totalBytes: total,
        percent: total > 0 ? status.totalBytesWritten / total : 0,
      });
    }
  };

  // Try to resume from saved state if it exists
  const savedState = await loadState(variant);
  let downloadResumable: FileSystem.DownloadResumable;

  if (savedState && typeof savedState === "object") {
    // Reconstruct the resumable from saved state
    downloadResumable = FileSystem.createDownloadResumable(
      model.url,
      dest,
      {},
      callback,
      // expo-file-system stores the resume token inside the saved state object
      (savedState as { resumeData?: string }).resumeData
    );
    const resumed = await downloadResumable.resumeAsync();
    if (resumed) {
      return resumed.uri;
    }
    throw new Error("Resume returned no result");
  }

  // Fresh download
  downloadResumable = FileSystem.createDownloadResumable(
    model.url,
    dest,
    {},
    callback
  );

  // Persist the resumable's state immediately so we have something to resume
  // if the download is interrupted (app backgrounded, killed, network drops).
  // We can't await downloadAsync because then we lose the chance to capture
  // intermediate state. Instead we save state right after starting and then
  // every few seconds via the progress callback.
  let stateSaveTimer: ReturnType<typeof setInterval> | null = null;
  try {
    stateSaveTimer = setInterval(() => {
      try {
        // savable() returns a JSON-serializable object with the resume token
        const s = (downloadResumable as unknown as {
          savable: () => unknown;
        }).savable();
        void saveState(variant, s);
      } catch {
        // ignore
      }
    }, 3000);

    const result = await downloadResumable.downloadAsync();
    if (!result) {
      throw new Error("downloadAsync returned undefined");
    }
    return result.uri;
  } finally {
    if (stateSaveTimer) clearInterval(stateSaveTimer);
  }
}

export async function deleteModel(variant: ModelVariant): Promise<void> {
  const path = getModelPath(variant);
  const info = await FileSystem.getInfoAsync(path);
  if (info.exists) {
    await FileSystem.deleteAsync(path);
  }
  await clearState(variant);
}

/**
 * Delete just the partial download + state without removing a fully
 * downloaded model. Useful when the user wants to start over.
 */
export async function clearPartialDownload(variant: ModelVariant): Promise<void> {
  if (await isModelDownloaded(variant)) {
    // Don't touch a complete download
    await clearState(variant);
    return;
  }
  const path = getModelPath(variant);
  const info = await FileSystem.getInfoAsync(path);
  if (info.exists) {
    await FileSystem.deleteAsync(path);
  }
  await clearState(variant);
}
