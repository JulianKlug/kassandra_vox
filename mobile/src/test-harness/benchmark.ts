/**
 * Performance benchmark for on-device execution.
 *
 * Runs each spike recording through the configured STT engine,
 * applies corrections, and computes WER against ground truth.
 * Measures wall-clock time for each step.
 *
 * Model config lives in ./model-config.ts. To test a different model:
 * 1. Push model files to device via adb
 * 2. Update model-config.ts with the new path/type
 * 3. Rebuild + run
 * 4. Copy results to tools/model-eval/registry.json
 */

import * as FileSystem from "expo-file-system/legacy";
import { transcribeFileOffline, isWhisperReady } from "../stt/whisper-offline";
import { getSherpaEngine, isSherpaReady } from "../stt/sherpa-streaming";
import { applyCorrections } from "../pipeline/correct";
import { computeWer, computeAggregateWer, formatWer, WerResult } from "./wer";
import { TEST_RECORDINGS, PROSE_RECORDINGS, TestRecording } from "./test-data";
import { OFFLINE_MODEL, STREAMING_MODEL } from "./model-config";

export interface BenchmarkFileResult {
  id: string;
  type: "prose" | "structured";
  /** Offline engine results */
  offline: {
    rawText: string;
    correctedText: string;
    inferenceMs: number;
    wer: WerResult;
    correctedWer: WerResult;
  } | null;
  /** Ground truth reference text */
  reference: string;
  error?: string;
}

export interface BenchmarkReport {
  timestamp: string;
  device: string;
  modelId: string;
  modelName: string;
  files: BenchmarkFileResult[];
  aggregate: {
    offlineRawWer: number;
    offlineCorrectedWer: number;
    avgInferenceMs: number;
    totalFiles: number;
    successfulFiles: number;
    proseOnlyRawWer: number;
    proseOnlyCorrectedWer: number;
  };
}

/**
 * Load ground truth reference text from a JSON file.
 */
async function loadGroundTruth(path: string): Promise<string> {
  const plainPath = path.replace(/^file:\/\//, "");
  const content = await FileSystem.readAsStringAsync(`file://${plainPath}`);
  const data = JSON.parse(content);
  return data.reference;
}

/**
 * Transcribe a WAV file through the streaming engine by feeding audio chunks.
 * Returns the final transcription text.
 */
async function transcribeFileStreaming(audioFile: string): Promise<string> {
  const engine = getSherpaEngine();
  if (!engine) throw new Error("Streaming engine not ready");

  // Read WAV as base64, decode to samples
  const audioB64 = await FileSystem.readAsStringAsync(audioFile, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const raw = Uint8Array.from(
    atob(audioB64).split("").map((c: string) => c.charCodeAt(0))
  );

  // Skip WAV header (44 bytes for standard, some files have 78), find 'data' chunk
  let dataOffset = 44;
  for (let i = 0; i < Math.min(raw.length, 200); i++) {
    if (raw[i] === 0x64 && raw[i+1] === 0x61 && raw[i+2] === 0x74 && raw[i+3] === 0x61) { // "data"
      dataOffset = i + 8; // skip "data" + 4-byte size
      break;
    }
  }

  // Convert int16 to float32
  const samples: number[] = [];
  for (let i = dataOffset; i < raw.length - 1; i += 2) {
    const int16 = raw[i] | (raw[i + 1] << 8);
    const signed = int16 > 32767 ? int16 - 65536 : int16;
    samples.push(signed / 32768);
  }

  // Feed to streaming engine in 1-second chunks
  const stream = await engine.createStream();
  const chunkSize = 16000;
  for (let i = 0; i < samples.length; i += chunkSize) {
    const chunk = samples.slice(i, Math.min(i + chunkSize, samples.length));
    await stream.processAudioChunk(Array.from(chunk), 16000);
  }
  await stream.inputFinished();
  const result = await stream.getResult();
  await stream.release();
  return result.text;
}

/**
 * Run the full benchmark on all spike recordings.
 */
export async function runBenchmark(): Promise<BenchmarkReport> {
  console.log("[VoxBench] === Starting benchmark ===");
  console.log(`[VoxBench] Model: ${OFFLINE_MODEL.name} (${OFFLINE_MODEL.id})`);
  console.log(`[VoxBench] Path: ${OFFLINE_MODEL.localPath}`);

  if (!isWhisperReady()) {
    throw new Error("Offline engine not ready. Init before benchmarking.");
  }

  const results: BenchmarkFileResult[] = [];

  for (const rec of TEST_RECORDINGS) {
    console.log(`[VoxBench] Processing: ${rec.id}`);

    // Check files exist
    const audioInfo = await FileSystem.getInfoAsync(rec.audioFile);
    if (!audioInfo.exists) {
      console.warn(`[VoxBench] SKIP ${rec.id}: audio file missing`);
      results.push({
        id: rec.id,
        type: rec.type,
        offline: null,
        reference: "",
        error: "Audio file missing",
      });
      continue;
    }

    // Load ground truth
    let reference = "";
    try {
      reference = await loadGroundTruth(rec.groundTruthFile);
    } catch (e: any) {
      console.warn(`[VoxBench] SKIP ${rec.id}: ground truth missing: ${e?.message}`);
      results.push({
        id: rec.id,
        type: rec.type,
        offline: null,
        reference: "",
        error: `Ground truth missing: ${e?.message}`,
      });
      continue;
    }

    // Run offline engine
    let offlineResult: BenchmarkFileResult["offline"] = null;
    try {
      const audioPath = rec.audioFile.replace(/^file:\/\//, "");
      const startMs = Date.now();
      const rawText = await transcribeFileOffline(audioPath);
      const inferenceMs = Date.now() - startMs;

      const corrected = applyCorrections(rawText.toLowerCase().trim());
      const correctedText = corrected.text.trim();

      const rawWer = computeWer(reference, rawText);
      const correctedWer = computeWer(reference, correctedText);

      offlineResult = {
        rawText,
        correctedText,
        inferenceMs,
        wer: rawWer,
        correctedWer,
      };

      console.log(`[VoxBench] ${rec.id}: ${inferenceMs}ms, raw WER=${(rawWer.wer * 100).toFixed(1)}%, corrected WER=${(correctedWer.wer * 100).toFixed(1)}%`);
    } catch (e: any) {
      console.warn(`[VoxBench] ${rec.id}: offline error: ${e?.message}`);
    }

    results.push({
      id: rec.id,
      type: rec.type,
      offline: offlineResult,
      reference,
    });
  }

  // Compute aggregates
  const successful = results.filter(r => r.offline !== null);
  const proseSuccessful = successful.filter(r => r.type === "prose");

  const allPairs = successful.map(r => ({
    reference: r.reference,
    hypothesis: r.offline!.rawText,
  }));
  const allCorrectedPairs = successful.map(r => ({
    reference: r.reference,
    hypothesis: r.offline!.correctedText,
  }));
  const prosePairs = proseSuccessful.map(r => ({
    reference: r.reference,
    hypothesis: r.offline!.rawText,
  }));
  const proseCorrectedPairs = proseSuccessful.map(r => ({
    reference: r.reference,
    hypothesis: r.offline!.correctedText,
  }));

  const aggRaw = computeAggregateWer(allPairs);
  const aggCorrected = computeAggregateWer(allCorrectedPairs);
  const proseRaw = computeAggregateWer(prosePairs);
  const proseCorrected = computeAggregateWer(proseCorrectedPairs);
  const avgInference = successful.length > 0
    ? successful.reduce((sum, r) => sum + r.offline!.inferenceMs, 0) / successful.length
    : 0;

  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    device: "emulator", // TODO: detect device model
    modelId: OFFLINE_MODEL.id,
    modelName: OFFLINE_MODEL.name,
    files: results,
    aggregate: {
      offlineRawWer: aggRaw.wer,
      offlineCorrectedWer: aggCorrected.wer,
      avgInferenceMs: avgInference,
      totalFiles: results.length,
      successfulFiles: successful.length,
      proseOnlyRawWer: proseRaw.wer,
      proseOnlyCorrectedWer: proseCorrected.wer,
    },
  };

  // Print summary
  console.log(`[VoxBench] === BENCHMARK RESULTS ===`);
  console.log(`[VoxBench] Files: ${successful.length}/${results.length} successful`);
  console.log(`[VoxBench] Avg inference: ${avgInference.toFixed(0)}ms`);
  console.log(`[VoxBench] Overall WER (raw): ${(aggRaw.wer * 100).toFixed(1)}%`);
  console.log(`[VoxBench] Overall WER (corrected): ${(aggCorrected.wer * 100).toFixed(1)}%`);
  console.log(`[VoxBench] Prose WER (raw): ${(proseRaw.wer * 100).toFixed(1)}%`);
  console.log(`[VoxBench] Prose WER (corrected): ${(proseCorrected.wer * 100).toFixed(1)}%`);
  console.log(`[VoxBench] Spike baseline: 44.9% raw → 42.3% corrected (whisper-large-v3 on Mac)`);

  // ── Streaming benchmark (if engine is ready) ──
  if (isSherpaReady()) {
    console.log(`[VoxBench] === STREAMING BENCHMARK ===`);
    for (const rec of TEST_RECORDINGS) {
      const audioInfo = await FileSystem.getInfoAsync(rec.audioFile);
      if (!audioInfo.exists) continue;

      let reference = "";
      try { reference = await loadGroundTruth(rec.groundTruthFile); } catch { continue; }

      try {
        const startMs = Date.now();
        const rawText = await transcribeFileStreaming(rec.audioFile);
        const inferenceMs = Date.now() - startMs;

        const corrected = applyCorrections(rawText.toLowerCase().trim());
        const rawWer = computeWer(reference, rawText);
        const correctedWer = computeWer(reference, corrected.text.trim());

        console.log(`[VoxBench] STREAM ${rec.id}: ${inferenceMs}ms, raw WER=${(rawWer.wer * 100).toFixed(1)}%, corrected WER=${(correctedWer.wer * 100).toFixed(1)}%`);
      } catch (e: any) {
        console.warn(`[VoxBench] STREAM ${rec.id}: error: ${e?.message?.slice(0, 100)}`);
      }
    }
  } else {
    console.log(`[VoxBench] Streaming engine not ready, skipping streaming benchmark`);
  }

  return report;
}
