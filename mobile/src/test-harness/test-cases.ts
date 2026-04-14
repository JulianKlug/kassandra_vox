/**
 * Integration test cases for on-device execution.
 *
 * These tests run inside the app on the emulator/device, exercising real
 * native code paths (sherpa-onnx, expo-file-system, etc.) that Jest can't
 * reach through mocks.
 *
 * Each test returns { pass: boolean, message: string, durationMs: number }.
 */

import * as FileSystem from "expo-file-system/legacy";
import { applyCorrections } from "../pipeline/correct";
import {
  createSegment,
  buildTranscript,
  appendSamples,
  samplesToWav,
  uint8ToBase64,
} from "../stt/segment-manager";
import {
  isSherpaReady,
  ensureFrenchModel,
  initSherpaEngine,
  getSherpaEngine,
} from "../stt/sherpa-streaming";
import {
  isWhisperReady,
  initOfflineEngine,
  transcribeFileOffline,
} from "../stt/whisper-offline";
import { TEST_RECORDINGS } from "./test-data";

export interface TestResult {
  name: string;
  pass: boolean;
  message: string;
  durationMs: number;
}

type TestFn = () => Promise<TestResult>;

function test(name: string, fn: () => Promise<void>): TestFn {
  return async () => {
    const start = Date.now();
    try {
      await fn();
      return { name, pass: true, message: "OK", durationMs: Date.now() - start };
    } catch (e: any) {
      return {
        name,
        pass: false,
        message: e?.message ?? String(e),
        durationMs: Date.now() - start,
      };
    }
  };
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ── Test definitions ────────────────────────────────────

const tests: TestFn[] = [
  // 1. Streaming engine init
  test("streaming_engine_init", async () => {
    if (!isSherpaReady()) {
      const modelPath = await ensureFrenchModel();
      await initSherpaEngine(modelPath);
    }
    assert(isSherpaReady(), "Sherpa engine should be ready after init");
  }),

  // 2. Offline engine init
  test("offline_engine_init", async () => {
    if (!isWhisperReady()) {
      await initOfflineEngine();
    }
    assert(isWhisperReady(), "Offline engine should be ready after init");
  }),

  // 3. Test data exists on device
  test("test_data_exists", async () => {
    const firstRecording = TEST_RECORDINGS[0];
    const audioInfo = await FileSystem.getInfoAsync(firstRecording.audioFile);
    assert(audioInfo.exists, `Audio file missing: ${firstRecording.audioFile}`);
    const gtInfo = await FileSystem.getInfoAsync(firstRecording.groundTruthFile);
    assert(gtInfo.exists, `Ground truth missing: ${firstRecording.groundTruthFile}`);
  }),

  // 4. Offline transcription produces non-empty French text
  test("offline_transcription_produces_text", async () => {
    assert(isWhisperReady(), "Offline engine must be ready");
    const wavPath = TEST_RECORDINGS[0].audioFile;
    const text = await transcribeFileOffline(wavPath);
    assert(text.trim().length > 0, `Expected non-empty text, got: "${text}"`);
    // Should contain French words, not English
    const lower = text.toLowerCase();
    const hasFrench = lower.includes("patient") || lower.includes("le") || lower.includes("un");
    assert(hasFrench, `Expected French text, got: "${text.slice(0, 100)}"`);
  }),

  // 5. Offline transcription consistency (same file twice)
  test("offline_transcription_consistency", async () => {
    assert(isWhisperReady(), "Offline engine must be ready");
    const wavPath = TEST_RECORDINGS[0].audioFile;
    const text1 = await transcribeFileOffline(wavPath);
    const text2 = await transcribeFileOffline(wavPath);
    assert(text1.trim().length > 0, `First transcription empty`);
    assert(text2.trim().length > 0, `Second transcription empty (the bug we hit on S22)`);
  }),

  // 6. Correction pipeline applies corrections
  test("correction_pipeline", async () => {
    const input = "le patient arrive hémodialyquement instable avec des poux perçues";
    const { text, applied } = applyCorrections(input);
    assert(applied.length > 0, "Expected at least one correction applied");
    assert(text.includes("hémodynamiquement"), `Expected corrected term, got: "${text}"`);
    assert(text.includes("pouls perçus"), `Expected corrected term, got: "${text}"`);
  }),

  // 7. WAV encoding round-trip
  test("wav_encoding", async () => {
    // Create a small WAV, write to file, verify it exists with correct size
    const samples = new Array(16000).fill(0.1); // 1 second
    const wav = samplesToWav(samples);
    assert(wav.length === 44 + 16000 * 2, `Expected ${44 + 32000} bytes, got ${wav.length}`);

    const base64 = uint8ToBase64(wav);
    assert(base64.length > 0, "Base64 should not be empty");

    const testPath = `${FileSystem.cacheDirectory}vox-wav-test.wav`;
    await FileSystem.writeAsStringAsync(testPath, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });

    const info = await FileSystem.getInfoAsync(testPath);
    assert(info.exists, "WAV file should exist after write");
    const size = (info as { size?: number }).size ?? 0;
    assert(size === wav.length, `Expected file size ${wav.length}, got ${size}`);

    // Clean up
    await FileSystem.deleteAsync(testPath, { idempotent: true });
  }),

  // 8. File URI stripping for sherpa-onnx
  test("file_uri_handling", async () => {
    // Write a WAV file via expo-fs (produces file:// URI)
    const samples = new Array(16000).fill(0.1);
    const wav = samplesToWav(samples);
    const base64 = uint8ToBase64(wav);
    const wavPath = `${FileSystem.cacheDirectory}vox-uri-test.wav`;
    await FileSystem.writeAsStringAsync(wavPath, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });

    // The path from expo-fs starts with file://
    assert(wavPath.startsWith("file://"), `Expected file:// URI, got: ${wavPath}`);

    // Strip and verify the plain path works
    const plainPath = wavPath.replace(/^file:\/\//, "");
    assert(!plainPath.startsWith("file://"), "Plain path should not have file:// prefix");
    assert(plainPath.startsWith("/"), "Plain path should start with /");

    // Clean up
    await FileSystem.deleteAsync(wavPath, { idempotent: true });
  }),

  // 9. Segment management
  test("segment_management", async () => {
    const seg0 = createSegment(0);
    seg0.streamingText = "rough text";
    seg0.offlineText = "accurate text";
    const seg1 = createSegment(1);
    seg1.streamingText = "current partial";

    const transcript = buildTranscript([seg0], seg1);
    assert(
      transcript.includes("accurate text"),
      "Should prefer offline text"
    );
    assert(
      !transcript.includes("rough text"),
      "Should not include rough when offline available"
    );
    assert(
      transcript.includes("current partial"),
      "Should include current segment"
    );
  }),

  // 10. Audio sample accumulation with cap
  test("audio_sample_accumulation", async () => {
    const seg = createSegment(0);
    const chunk = new Float32Array(1000).fill(0.5);
    const added = appendSamples(seg, chunk);
    assert(added === 1000, `Expected 1000 added, got ${added}`);
    assert(seg.audioSamples.length === 1000, `Expected 1000 samples, got ${seg.audioSamples.length}`);
  }),
];

/**
 * Run all integration tests and return results.
 */
export async function runIntegrationTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const testFn of tests) {
    const result = await testFn();
    results.push(result);
    const icon = result.pass ? "✓" : "✗";
    console.log(`[VoxTest] ${icon} ${result.name} (${result.durationMs}ms) ${result.pass ? "" : "- " + result.message}`);
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`[VoxTest] === ${passed} passed, ${failed} failed, ${results.length} total ===`);

  return results;
}
