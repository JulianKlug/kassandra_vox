/**
 * whisper.rn wrapper.
 *
 * Loads a Whisper model and provides chunked transcription with the
 * medical vocabulary prompt that we validated in the spike.
 */

import { initWhisper, WhisperContext } from "whisper.rn";
import type { TranscribeResult as RNTranscribeResult } from "whisper.rn";
import { getModelPath, ModelVariant } from "./model";

type Segment = RNTranscribeResult["segments"][number];

// Medical vocabulary prompt (from spike/prompt.txt)
// Whisper treats this as "previous context" and biases the decoder toward
// these words. Validated to improve French medical term accuracy.
export const MEDICAL_PROMPT_FR =
  "Le patient presente une hypertension arterielle traitee par metformine 500 mg deux fois par jour. " +
  "Examen clinique: tension arterielle 138/82 mmHg, frequence cardiaque 72 bpm, HbA1c 7.2%. " +
  "IMC 28.4. Prescription: omeprazole 20 mg, lisinopril 10 mg. Diagnostic: diabete de type 2, " +
  "hypercholesterolemie. Auscultation pulmonaire sans particularite. Pouls pedieux presents " +
  "bilateralement. Amoxicilline 1g trois fois par jour pendant 7 jours. INR 2.3, AVK bien equilibre.";

export interface TranscribeResult {
  text: string;
  segments: Array<{ text: string; t0: number; t1: number }>;
  durationMs: number;
}

let context: WhisperContext | null = null;
let loadedVariant: ModelVariant | null = null;

export async function loadModel(variant: ModelVariant): Promise<void> {
  if (context && loadedVariant === variant) return;
  if (context) {
    await context.release();
    context = null;
  }
  const filePath = getModelPath(variant);
  context = await initWhisper({ filePath });
  loadedVariant = variant;
}

export async function unloadModel(): Promise<void> {
  if (context) {
    await context.release();
    context = null;
    loadedVariant = null;
  }
}

export function isModelLoaded(): boolean {
  return context !== null;
}

export async function transcribeFile(audioPath: string): Promise<TranscribeResult> {
  if (!context) {
    throw new Error("Model not loaded. Call loadModel() first.");
  }

  const start = Date.now();
  const { promise } = context.transcribe(audioPath, {
    language: "fr",
    initialPrompt: MEDICAL_PROMPT_FR,
    maxThreads: 4,
  });
  const result = await promise;
  const durationMs = Date.now() - start;

  return {
    text: result.result,
    segments: result.segments.map((s: Segment) => ({
      text: s.text,
      t0: s.t0,
      t1: s.t1,
    })),
    durationMs,
  };
}
