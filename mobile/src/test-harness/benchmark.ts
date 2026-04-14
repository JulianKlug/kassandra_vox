/**
 * Performance benchmark for on-device execution.
 *
 * Runs each spike recording through both STT engines (streaming zipformer
 * and offline Canary), applies corrections, and computes WER against
 * ground truth. Measures wall-clock time for each step.
 */

import * as FileSystem from "expo-file-system/legacy";
import { transcribeFileOffline, isWhisperReady } from "../stt/whisper-offline";
import { applyCorrections } from "../pipeline/correct";
import { computeWer, computeAggregateWer, formatWer, WerResult } from "./wer";
import { TEST_RECORDINGS, PROSE_RECORDINGS, TestRecording } from "./test-data";

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
 * Run the full benchmark on all spike recordings.
 */
export async function runBenchmark(): Promise<BenchmarkReport> {
  console.log("[VoxBench] === Starting benchmark ===");

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

  return report;
}
