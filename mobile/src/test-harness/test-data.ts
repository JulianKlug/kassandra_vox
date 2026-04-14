/**
 * Test data paths and ground truth for device-based testing.
 *
 * Test audio files and ground truth JSON are pushed to the device via:
 *   adb push spike/data/converted/ /data/local/tmp/vox-test/audio/
 *   adb push spike/data/ground_truth/ /data/local/tmp/vox-test/ground-truth/
 */

import * as FileSystem from "expo-file-system/legacy";

// Test data lives in the app's document directory (app-accessible)
// Files are pushed via: adb push ... /sdcard/ then copied by setupTestData()
const TEST_DATA_BASE = `${FileSystem.documentDirectory}vox-test`;

export const TEST_AUDIO_DIR = `${TEST_DATA_BASE}/audio`;
export const TEST_GROUND_TRUTH_DIR = `${TEST_DATA_BASE}/ground-truth`;

// Source location where adb pushes files (world-readable)
const ADB_STAGING = "/data/local/tmp/vox-test";

/**
 * Copy test data from adb staging area to app document directory.
 * Call this before running tests. Safe to call multiple times.
 */
export async function setupTestData(): Promise<void> {
  // Create dirs
  for (const dir of [TEST_AUDIO_DIR, TEST_GROUND_TRUTH_DIR]) {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
  }

  // Copy audio files from staging
  for (const rec of TEST_RECORDINGS) {
    const destAudio = rec.audioFile;
    const srcAudio = `${ADB_STAGING}/audio/${rec.id}.wav`;
    const destInfo = await FileSystem.getInfoAsync(destAudio);
    if (!destInfo.exists) {
      try {
        await FileSystem.copyAsync({ from: `file://${srcAudio}`, to: destAudio });
      } catch {
        // Staging file may not exist, that's OK (test will report it missing)
      }
    }
  }

  // Copy ground truth files from staging
  for (const rec of TEST_RECORDINGS) {
    const destGt = rec.groundTruthFile;
    const srcGt = `${ADB_STAGING}/ground-truth/${rec.id}.json`;
    const destInfo = await FileSystem.getInfoAsync(destGt);
    if (!destInfo.exists) {
      try {
        await FileSystem.copyAsync({ from: `file://${srcGt}`, to: destGt });
      } catch {}
    }
  }
}

/** Test recording metadata */
export interface TestRecording {
  id: string;
  audioFile: string;
  groundTruthFile: string;
  /** Expected content type for filtering */
  type: "prose" | "structured";
}

/**
 * The 10 spike recordings with their ground truth.
 * IDs match the filenames in spike/data/converted/ and spike/data/ground_truth/.
 */
export const TEST_RECORDINGS: TestRecording[] = [
  { id: "Voice 260331_225712", type: "prose",
    audioFile: `${TEST_AUDIO_DIR}/Voice 260331_225712.wav`,
    groundTruthFile: `${TEST_GROUND_TRUTH_DIR}/Voice 260331_225712.json` },
  { id: "Voice 260331_225748", type: "prose",
    audioFile: `${TEST_AUDIO_DIR}/Voice 260331_225748.wav`,
    groundTruthFile: `${TEST_GROUND_TRUTH_DIR}/Voice 260331_225748.json` },
  { id: "Voice 260331_225822", type: "prose",
    audioFile: `${TEST_AUDIO_DIR}/Voice 260331_225822.wav`,
    groundTruthFile: `${TEST_GROUND_TRUTH_DIR}/Voice 260331_225822.json` },
  { id: "Voice 260331_225933", type: "structured",
    audioFile: `${TEST_AUDIO_DIR}/Voice 260331_225933.wav`,
    groundTruthFile: `${TEST_GROUND_TRUTH_DIR}/Voice 260331_225933.json` },
  { id: "Voice 260331_230119", type: "prose",
    audioFile: `${TEST_AUDIO_DIR}/Voice 260331_230119.wav`,
    groundTruthFile: `${TEST_GROUND_TRUTH_DIR}/Voice 260331_230119.json` },
  { id: "Voice 260331_230214", type: "structured",
    audioFile: `${TEST_AUDIO_DIR}/Voice 260331_230214.wav`,
    groundTruthFile: `${TEST_GROUND_TRUTH_DIR}/Voice 260331_230214.json` },
  { id: "Voice 260403_224134", type: "structured",
    audioFile: `${TEST_AUDIO_DIR}/Voice 260403_224134.wav`,
    groundTruthFile: `${TEST_GROUND_TRUTH_DIR}/Voice 260403_224134.json` },
  { id: "Voice 260403_224258", type: "prose",
    audioFile: `${TEST_AUDIO_DIR}/Voice 260403_224258.wav`,
    groundTruthFile: `${TEST_GROUND_TRUTH_DIR}/Voice 260403_224258.json` },
  { id: "Voice 260403_224558", type: "prose",
    audioFile: `${TEST_AUDIO_DIR}/Voice 260403_224558.wav`,
    groundTruthFile: `${TEST_GROUND_TRUTH_DIR}/Voice 260403_224558.json` },
  { id: "Voice 260403_225013", type: "structured",
    audioFile: `${TEST_AUDIO_DIR}/Voice 260403_225013.wav`,
    groundTruthFile: `${TEST_GROUND_TRUTH_DIR}/Voice 260403_225013.json` },
];

/** Prose-only recordings (meaningful WER comparison) */
export const PROSE_RECORDINGS = TEST_RECORDINGS.filter(r => r.type === "prose");
