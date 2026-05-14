/**
 * Progressive offline-pass schedule sweep.
 *
 * For each spike recording and each candidate schedule, slice the WAV at
 * each mark, run streaming + offline on the prefix, apply corrections, and
 * record latency, WER, and gate decision. Produces a Pareto table that
 * tells us which mark schedule minimizes perceived-latency without
 * regressing final WER.
 *
 * Runs on the emulator alongside the benchmark; see run-tests.ts Phase 3.
 *
 * Design notes (mirrors docs/specs/progressive-offline-passes.md):
 *   - WER is computed against full ground truth even for short prefixes.
 *     Intermediate WER will look high — that's expected. The accuracy
 *     metric is finalCorrectedWer (last gate-passing pass); the
 *     perceived-latency metric is msToFirstGatePass.
 *   - Streaming is re-run on each prefix solely to provide a realistic
 *     gate baseline. Its time is reported but excluded from production
 *     cost — production runs streaming continuously over live audio
 *     regardless of the offline schedule.
 */

import * as FileSystem from "expo-file-system/legacy";
import { transcribeFileOffline, isWhisperReady } from "../stt/whisper-offline";
import { isSherpaReady } from "../stt/sherpa-streaming";
import { applyCorrections } from "../pipeline/correct";
import {
  addDither,
  samplesToWav,
  uint8ToBase64,
  gateOfflineText,
  SAMPLE_RATE,
} from "../stt/segment-manager";
import { computeWer } from "./wer";
import { TEST_RECORDINGS } from "./test-data";
import { transcribeFileStreaming } from "./benchmark";

export interface PassResult {
  markSec: number | "full";
  audioDurSec: number;
  /** NeMo CTC inference time on the prefix (the production cost). */
  offlineInferenceMs: number;
  /** Zipformer streaming inference on the same prefix — gate baseline, not counted. */
  streamingInferenceMs: number;
  rawText: string;
  correctedText: string;
  streamingText: string;
  rawWer: number;
  correctedWer: number;
  gatePassed: boolean;
  gateReason?: string;
  skipped?: "below-min-audio";
}

export interface FileSweepResult {
  id: string;
  passes: PassResult[];
  /** Sum of offlineInferenceMs across passes — the metric that maps to production cost. */
  totalOfflineInferenceMs: number;
  /** Sum of streamingInferenceMs — reported, not counted as production cost. */
  totalStreamingInferenceMs: number;
  /** WER of the last gate-passing pass; if none passed, of the last pass. */
  finalCorrectedWer: number;
  /** Cumulative offlineInferenceMs up to and including the first gate-passing pass. */
  msToFirstGatePass: number | null;
}

export interface ScheduleResult {
  schedule: readonly (number | "full")[];
  perFile: FileSweepResult[];
  aggregate: {
    meanTotalOfflineInferenceMs: number;
    meanTotalStreamingInferenceMs: number;
    meanFinalCorrectedWer: number;
    meanMsToFirstGatePass: number | null;
    gatePassRate: number;
  };
}

/**
 * Schedules to sweep. Each entry is a list of marks (seconds of audio)
 * at which a progressive pass would fire, plus "full" for the endpoint pass.
 * The baseline ["full"] reproduces today's behavior.
 */
export const SWEEP_SCHEDULES: readonly (readonly (number | "full")[])[] = [
  ["full"],
  [10, "full"],
  [5, 10, "full"],
  [5, 10, 15, "full"],
  [3, 5, 7, 10, 15, "full"],
];

const MIN_PREFIX_SEC = 3;

/** Decode a 16-bit PCM mono WAV file at the given path into float32 samples in [-1, 1]. */
async function readWavSamples(audioFile: string): Promise<number[]> {
  const audioB64 = await FileSystem.readAsStringAsync(audioFile, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const raw = Uint8Array.from(
    atob(audioB64).split("").map((c) => c.charCodeAt(0)),
  );

  let dataOffset = 44;
  for (let i = 0; i < Math.min(raw.length, 200); i++) {
    if (raw[i] === 0x64 && raw[i + 1] === 0x61 && raw[i + 2] === 0x74 && raw[i + 3] === 0x61) {
      dataOffset = i + 8;
      break;
    }
  }

  const samples: number[] = [];
  for (let i = dataOffset; i < raw.length - 1; i += 2) {
    const int16 = raw[i] | (raw[i + 1] << 8);
    const signed = int16 > 32767 ? int16 - 65536 : int16;
    samples.push(signed / 32768);
  }
  return samples;
}

async function loadGroundTruth(path: string): Promise<string> {
  const plainPath = path.replace(/^file:\/\//, "");
  const content = await FileSystem.readAsStringAsync(`file://${plainPath}`);
  const data = JSON.parse(content);
  return data.reference as string;
}

async function writePrefixWav(samples: number[]): Promise<string> {
  const wavPath = `${FileSystem.cacheDirectory}vox-sweep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`;
  const wavBytes = samplesToWav(samples);
  const base64 = uint8ToBase64(wavBytes);
  await FileSystem.writeAsStringAsync(wavPath, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return wavPath;
}

async function runPass(
  prefix: number[],
  markSec: number | "full",
  reference: string,
): Promise<PassResult> {
  const dithered = addDither(prefix);
  const wavPath = await writePrefixWav(dithered);
  const audioDurSec = prefix.length / SAMPLE_RATE;

  let rawText = "";
  let offlineInferenceMs = 0;
  let streamingText = "";
  let streamingInferenceMs = 0;
  try {
    const offStart = Date.now();
    rawText = await transcribeFileOffline(wavPath);
    offlineInferenceMs = Date.now() - offStart;

    const streamStart = Date.now();
    streamingText = await transcribeFileStreaming(wavPath);
    streamingInferenceMs = Date.now() - streamStart;
  } finally {
    try { await FileSystem.deleteAsync(wavPath, { idempotent: true }); } catch {}
  }

  const correctedText = applyCorrections(rawText.toLowerCase().trim()).text.trim();
  const decision = gateOfflineText(streamingText, correctedText);

  return {
    markSec,
    audioDurSec,
    offlineInferenceMs,
    streamingInferenceMs,
    rawText,
    correctedText,
    streamingText,
    rawWer: computeWer(reference, rawText).wer,
    correctedWer: computeWer(reference, correctedText).wer,
    gatePassed: decision.source === "offline",
    gateReason: decision.rejectionReason,
  };
}

async function runScheduleForFile(
  samples: number[],
  reference: string,
  fileId: string,
  schedule: readonly (number | "full")[],
): Promise<FileSweepResult> {
  const fullDurSec = samples.length / SAMPLE_RATE;
  const passes: PassResult[] = [];
  let cumulativeOfflineMs = 0;
  let msToFirstGatePass: number | null = null;
  let lastGatePassedCorrectedWer: number | null = null;

  for (const mark of schedule) {
    const dur = mark === "full" ? fullDurSec : Math.min(mark, fullDurSec);

    if (dur < MIN_PREFIX_SEC) {
      passes.push({
        markSec: mark,
        audioDurSec: dur,
        offlineInferenceMs: 0,
        streamingInferenceMs: 0,
        rawText: "",
        correctedText: "",
        streamingText: "",
        rawWer: 1,
        correctedWer: 1,
        gatePassed: false,
        skipped: "below-min-audio",
      });
      continue;
    }

    const cap = Math.floor(dur * SAMPLE_RATE);
    const prefix = samples.slice(0, cap);
    const result = await runPass(prefix, mark, reference);
    passes.push(result);

    cumulativeOfflineMs += result.offlineInferenceMs;
    if (result.gatePassed) {
      if (msToFirstGatePass === null) msToFirstGatePass = cumulativeOfflineMs;
      lastGatePassedCorrectedWer = result.correctedWer;
    }

    console.log(
      `[VoxSweep] ${fileId} mark=${mark}: dur=${dur.toFixed(1)}s, off=${result.offlineInferenceMs}ms, stream=${result.streamingInferenceMs}ms, corrWER=${(result.correctedWer * 100).toFixed(1)}%, gate=${result.gatePassed ? "PASS" : `FAIL(${result.gateReason})`}`,
    );
  }

  const runPasses = passes.filter((p) => !p.skipped);
  const finalCorrectedWer = lastGatePassedCorrectedWer
    ?? runPasses[runPasses.length - 1]?.correctedWer
    ?? 1;
  const totalStreamingMs = runPasses.reduce((s, p) => s + p.streamingInferenceMs, 0);

  return {
    id: fileId,
    passes,
    totalOfflineInferenceMs: cumulativeOfflineMs,
    totalStreamingInferenceMs: totalStreamingMs,
    finalCorrectedWer,
    msToFirstGatePass,
  };
}

function aggregateSchedule(
  schedule: readonly (number | "full")[],
  perFile: FileSweepResult[],
): ScheduleResult {
  const n = perFile.length;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

  const firstGateValues = perFile
    .map((f) => f.msToFirstGatePass)
    .filter((v): v is number => v !== null);

  const totalGatePairs = perFile.reduce(
    (sum, f) => sum + f.passes.filter((p) => !p.skipped).length,
    0,
  );
  const passedPairs = perFile.reduce(
    (sum, f) => sum + f.passes.filter((p) => p.gatePassed).length,
    0,
  );

  return {
    schedule,
    perFile,
    aggregate: {
      meanTotalOfflineInferenceMs: mean(perFile.map((f) => f.totalOfflineInferenceMs)),
      meanTotalStreamingInferenceMs: mean(perFile.map((f) => f.totalStreamingInferenceMs)),
      meanFinalCorrectedWer: mean(perFile.map((f) => f.finalCorrectedWer)),
      meanMsToFirstGatePass: firstGateValues.length ? mean(firstGateValues) : null,
      gatePassRate: totalGatePairs > 0 ? passedPairs / totalGatePairs : 0,
    },
  };
}

export async function runSweep(): Promise<ScheduleResult[]> {
  console.log("[VoxSweep] === Starting progressive-passes sweep ===");
  if (!isWhisperReady()) throw new Error("Offline engine not ready");
  if (!isSherpaReady()) throw new Error("Streaming engine not ready");

  // Decode each recording's samples + ground truth once and reuse across schedules.
  const inputs: { id: string; samples: number[]; reference: string }[] = [];
  for (const rec of TEST_RECORDINGS) {
    const audioInfo = await FileSystem.getInfoAsync(rec.audioFile);
    if (!audioInfo.exists) {
      console.warn(`[VoxSweep] SKIP ${rec.id}: audio missing`);
      continue;
    }
    let reference = "";
    try {
      reference = await loadGroundTruth(rec.groundTruthFile);
    } catch (e: any) {
      console.warn(`[VoxSweep] SKIP ${rec.id}: ground truth missing: ${e?.message}`);
      continue;
    }
    try {
      const samples = await readWavSamples(rec.audioFile);
      inputs.push({ id: rec.id, samples, reference });
    } catch (e: any) {
      console.warn(`[VoxSweep] SKIP ${rec.id}: decode error: ${e?.message}`);
    }
  }
  console.log(`[VoxSweep] Sweeping ${SWEEP_SCHEDULES.length} schedules × ${inputs.length} recordings`);

  const results: ScheduleResult[] = [];
  for (const schedule of SWEEP_SCHEDULES) {
    console.log(`[VoxSweep] --- Schedule [${schedule.join(", ")}] ---`);
    const perFile: FileSweepResult[] = [];
    for (const input of inputs) {
      try {
        const fileResult = await runScheduleForFile(input.samples, input.reference, input.id, schedule);
        perFile.push(fileResult);
      } catch (e: any) {
        console.warn(`[VoxSweep] ${input.id} schedule failed: ${e?.message}`);
      }
    }
    results.push(aggregateSchedule(schedule, perFile));
  }
  return results;
}

export function printSweepSummary(results: ScheduleResult[]): void {
  console.log("[VoxSweep] === SWEEP PARETO TABLE ===");
  console.log(
    "[VoxSweep] Schedule".padEnd(34) +
      "meanOfflineMs".padStart(15) +
      "meanFinalWER".padStart(15) +
      "msToFirstGate".padStart(15) +
      "gatePassRate".padStart(15),
  );
  for (const r of results) {
    const sched = `[${r.schedule.join(", ")}]`;
    const offMs = r.aggregate.meanTotalOfflineInferenceMs.toFixed(0);
    const wer = `${(r.aggregate.meanFinalCorrectedWer * 100).toFixed(1)}%`;
    const firstGate = r.aggregate.meanMsToFirstGatePass === null
      ? "—"
      : r.aggregate.meanMsToFirstGatePass.toFixed(0);
    const passRate = `${(r.aggregate.gatePassRate * 100).toFixed(0)}%`;
    console.log(
      ("[VoxSweep] " + sched).padEnd(34) +
        offMs.padStart(15) +
        wer.padStart(15) +
        firstGate.padStart(15) +
        passRate.padStart(15),
    );
  }
  console.log("[VoxSweep] Pick the schedule with the lowest msToFirstGate whose meanFinalWER ≤ baseline.");
}
