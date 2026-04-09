/**
 * whisper.rn wrapper using the new RealtimeTranscriber API.
 *
 * Uses @fugood/react-native-audio-pcm-stream for audio capture (16kHz
 * mono PCM, the exact format whisper.cpp expects). This replaces the
 * deprecated context.transcribeRealtime() method.
 */

import { initWhisper, WhisperContext } from "whisper.rn";
import { RealtimeTranscriber } from "whisper.rn/realtime-transcription";
import { AudioPcmStreamAdapter } from "whisper.rn/realtime-transcription/adapters";
import type { RealtimeTranscribeEvent } from "whisper.rn/realtime-transcription";
import { getModelPath, ModelVariant } from "./model";

// Medical vocabulary prompt (from spike/prompt.txt)
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

/**
 * Realtime dictation handle.
 */
export interface RealtimeHandle {
  stop: () => Promise<void>;
}

export interface RealtimeUpdate {
  text: string;
  isFinal: boolean;
  recordingTimeMs: number;
  processTimeMs: number;
}

/**
 * Start a realtime dictation session using the new RealtimeTranscriber API.
 *
 * AudioPcmStreamAdapter captures audio in 16kHz mono PCM, exactly what
 * whisper.cpp expects. No format conversion, no hallucination.
 */
export async function startRealtimeTranscription(
  onUpdate: (u: RealtimeUpdate) => void,
  onError: (msg: string) => void
): Promise<RealtimeHandle> {
  if (!context) {
    throw new Error("Model not loaded. Call loadModel() first.");
  }

  const audioStream = new AudioPcmStreamAdapter();

  const transcriber = new RealtimeTranscriber(
    {
      whisperContext: context,
      audioStream,
      // vadContext: skip for now (would need a separate VAD model download)
      // fs: skip (only needed for audioOutputPath / saving WAV files)
    },
    {
      audioSliceSec: 15,       // process audio in 15-second slices
      audioMinSec: 1,          // start transcribing after 1s of speech
      initialPrompt: MEDICAL_PROMPT_FR,
      transcribeOptions: {
        language: "fr",
        maxThreads: 4,
      },
      logger: (msg: string) => console.log(`[whisper] ${msg}`),
    },
    {
      onTranscribe: (event: RealtimeTranscribeEvent) => {
        if (event.data) {
          onUpdate({
            text: event.data.result,
            isFinal: !event.isCapturing,
            recordingTimeMs: event.recordingTime,
            processTimeMs: event.processTime,
          });
        }
      },
      onError: (errMsg: string) => {
        onError(errMsg);
      },
      onStatusChange: (isActive: boolean) => {
        if (!isActive) {
          // Transcriber stopped (could be from stop() or an error)
        }
      },
    }
  );

  await transcriber.start();

  return {
    stop: async () => {
      await transcriber.stop();
      await audioStream.release();
    },
  };
}
