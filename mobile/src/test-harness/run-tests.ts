/**
 * Test harness runner.
 *
 * Orchestrates integration tests and performance benchmarks.
 * Runs inside the app on a real device or emulator.
 *
 * Usage: launch app with test mode (deep link or intent extra).
 */

import { runIntegrationTests, TestResult } from "./test-cases";
import { runBenchmark, BenchmarkReport } from "./benchmark";
import { runSweep, printSweepSummary, ScheduleResult } from "./progressive-passes-sweep";
import { setupTestData } from "./test-data";

export interface TestHarnessResults {
  integration: TestResult[];
  benchmark: BenchmarkReport | null;
  sweep: ScheduleResult[] | null;
  summary: {
    integrationPassed: number;
    integrationFailed: number;
    integrationTotal: number;
    benchmarkCompleted: boolean;
    sweepCompleted: boolean;
  };
}

/**
 * Run the full test harness: integration tests first, then benchmark.
 */
export async function runTestHarness(): Promise<TestHarnessResults> {
  console.log("[VoxTest] ====================================");
  console.log("[VoxTest] VOX TEST HARNESS");
  console.log("[VoxTest] ====================================");

  // Phase 0: Setup test data
  console.log("[VoxTest] Setting up test data...");
  try {
    await setupTestData();
    console.log("[VoxTest] Test data ready.");
  } catch (e: any) {
    console.warn(`[VoxTest] Test data setup failed: ${e?.message ?? e}`);
  }

  // Phase 1: Integration tests
  console.log("[VoxTest]");
  console.log("[VoxTest] --- Integration Tests ---");
  const integration = await runIntegrationTests();

  const passed = integration.filter(r => r.pass).length;
  const failed = integration.filter(r => r.pass === false).length;

  // Phase 2: Benchmark (only if core engines initialized successfully)
  let benchmark: BenchmarkReport | null = null;
  const enginesOk = integration.find(r => r.name === "offline_engine_init")?.pass;
  const streamingOk = integration.find(r => r.name === "streaming_engine_init")?.pass;

  if (enginesOk) {
    console.log("[VoxTest]");
    console.log("[VoxTest] --- Performance Benchmark ---");
    try {
      benchmark = await runBenchmark();
    } catch (e: any) {
      console.error(`[VoxTest] Benchmark failed: ${e?.message ?? e}`);
    }
  } else {
    console.log("[VoxTest] Skipping benchmark: engines not initialized");
  }

  // Phase 3: Progressive-passes sweep (needs both engines for realistic gate baseline)
  let sweep: ScheduleResult[] | null = null;
  if (enginesOk && streamingOk) {
    console.log("[VoxTest]");
    console.log("[VoxTest] --- Progressive Passes Sweep ---");
    try {
      sweep = await runSweep();
      printSweepSummary(sweep);
    } catch (e: any) {
      console.error(`[VoxTest] Sweep failed: ${e?.message ?? e}`);
    }
  } else {
    console.log("[VoxTest] Skipping sweep: both offline + streaming engines required");
  }

  // Summary
  console.log("[VoxTest]");
  console.log("[VoxTest] ====================================");
  console.log("[VoxTest] SUMMARY");
  console.log(`[VoxTest] Integration: ${passed}/${integration.length} passed`);
  if (benchmark) {
    console.log(`[VoxTest] Benchmark: ${benchmark.aggregate.successfulFiles}/${benchmark.aggregate.totalFiles} files`);
    console.log(`[VoxTest] Avg inference: ${benchmark.aggregate.avgInferenceMs.toFixed(0)}ms`);
    console.log(`[VoxTest] WER (corrected): ${(benchmark.aggregate.offlineCorrectedWer * 100).toFixed(1)}%`);
  }
  if (sweep) {
    console.log(`[VoxTest] Sweep: ${sweep.length} schedules evaluated`);
  }
  console.log("[VoxTest] ====================================");

  return {
    integration,
    benchmark,
    sweep,
    summary: {
      integrationPassed: passed,
      integrationFailed: failed,
      integrationTotal: integration.length,
      benchmarkCompleted: benchmark !== null,
      sweepCompleted: sweep !== null,
    },
  };
}
