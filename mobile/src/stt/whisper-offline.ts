/**
 * Whisper offline second-pass engine.
 *
 * Uses whisper.rn with the distil-whisper-large-v3-french model (q5_0,
 * 513MB) to re-transcribe audio segments after the streaming zipformer
 * produces an initial rough transcript. The distilled model is fine-tuned
 * specifically for French and gives near-large-v3 accuracy at a fraction
 * of the size and speed.
 *
 * This runs AFTER the streaming pass, so latency is acceptable (5-10s
 * on an S22 for a 15-second audio segment).
 */

import { initWhisper, WhisperContext } from "whisper.rn";
import * as FileSystem from "expo-file-system/legacy";

const MODELS_DIR = `${FileSystem.documentDirectory}models/`;
const MODEL_FILENAME = "ggml-distil-fr-q5.bin";
const MODEL_URL =
  "https://huggingface.co/bofenghuang/whisper-large-v3-distil-fr-v0.2/resolve/main/ggml-model-q5_0.bin";
const MODEL_SIZE_BYTES = 537_819_875;

// Prompt to bias decoder toward medical vocabulary (validated in spike)
const MEDICAL_PROMPT =
  "Le patient presente une hypertension arterielle traitee par metformine 500 mg deux fois par jour. " +
  "Examen clinique: tension arterielle 138/82 mmHg, frequence cardiaque 72 bpm, HbA1c 7.2%. " +
  "IMC 28.4. Prescription: omeprazole 20 mg, lisinopril 10 mg. Diagnostic: diabete de type 2, " +
  "hypercholesterolemie. Auscultation pulmonaire sans particularite. Pouls pedieux presents " +
  "bilateralement. Amoxicilline 1g trois fois par jour pendant 7 jours. INR 2.3, AVK bien equilibre.";

let context: WhisperContext | null = null;

export interface WhisperDownloadProgress {
  percent: number;
  bytesWritten: number;
  totalBytes: number;
}

function getModelPath(): string {
  return `${MODELS_DIR}${MODEL_FILENAME}`;
}

export async function isWhisperModelDownloaded(): Promise<boolean> {
  const path = getModelPath();
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) return false;
  const size = (info as { size?: number }).size ?? 0;
  return size >= MODEL_SIZE_BYTES * 0.99;
}

export async function downloadWhisperModel(
  onProgress?: (p: WhisperDownloadProgress) => void
): Promise<void> {
  const dir = MODELS_DIR;
  const dirInfo = await FileSystem.getInfoAsync(dir);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }

  if (await isWhisperModelDownloaded()) return;

  const dest = getModelPath();
  const downloadResumable = FileSystem.createDownloadResumable(
    MODEL_URL,
    dest,
    {},
    (status) => {
      if (onProgress) {
        const total = status.totalBytesExpectedToWrite || MODEL_SIZE_BYTES;
        onProgress({
          bytesWritten: status.totalBytesWritten,
          totalBytes: total,
          percent: total > 0 ? (status.totalBytesWritten / total) * 100 : 0,
        });
      }
    }
  );

  const result = await downloadResumable.downloadAsync();
  if (!result) throw new Error("Whisper model download failed");
}

export async function initWhisperOffline(): Promise<void> {
  if (context) return;
  const path = getModelPath();
  console.log(`[vox] Loading whisper distil-fr from ${path}`);
  context = await initWhisper({ filePath: path });
  console.log("[vox] Whisper distil-fr loaded");
}

export function isWhisperReady(): boolean {
  return context !== null;
}

/**
 * Transcribe a WAV file with whisper distil-fr.
 * Returns the transcribed text.
 */
export async function transcribeOffline(wavPath: string): Promise<string> {
  if (!context) throw new Error("Whisper not initialized");

  const { promise } = context.transcribe(wavPath, {
    language: "fr",
    initialPrompt: MEDICAL_PROMPT,
    maxThreads: 4,
  });
  const result = await promise;
  return result.result;
}

export async function releaseWhisperOffline(): Promise<void> {
  if (context) {
    await context.release();
    context = null;
  }
}
