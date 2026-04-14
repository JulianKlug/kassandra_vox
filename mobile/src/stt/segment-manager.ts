/**
 * Segment management for the hybrid STT engine.
 *
 * Extracted from hybrid-engine.ts so the logic can be unit-tested
 * without mocking native modules (sherpa-onnx, PCM streams).
 *
 * A "segment" is a chunk of dictation between speech pauses.
 * Each segment has streaming (rough) text and optionally offline
 * (accurate) text from the second-pass engine.
 */

export const SAMPLE_RATE = 16000;
export const MIN_PASS_INTERVAL_MS = 5_000;
export const MIN_AUDIO_SAMPLES = SAMPLE_RATE * 3; // 3 seconds
export const MAX_NO_PASS_MS = 30_000;
export const MAX_SAMPLES_PER_SEGMENT = SAMPLE_RATE * 60; // 60 seconds cap

export interface Segment {
  index: number;
  streamingText: string;
  offlineText: string | null;
  audioSamples: number[];
}

export function createSegment(index: number): Segment {
  return { index, streamingText: "", offlineText: null, audioSamples: [] };
}

/**
 * Build the full transcript from finished segments + current in-progress segment.
 * Prefers offline text when available, falls back to streaming text.
 */
export function buildTranscript(
  finishedSegments: Segment[],
  currentSegment: Segment
): string {
  const parts: string[] = [];
  for (const seg of finishedSegments) {
    // Use offline text only if it's non-empty. An empty string from a
    // failed offline pass should NOT replace good streaming text.
    const t = (seg.offlineText && seg.offlineText.trim()) || seg.streamingText;
    if (t.trim()) parts.push(t.trim());
  }
  const current = currentSegment.streamingText;
  if (current.trim()) parts.push(current.trim());
  return parts.join(". ");
}

/**
 * Determine whether an offline pass should be triggered.
 */
export function shouldTriggerOfflinePass(
  currentSegment: Segment,
  lastPassTime: number,
  now: number
): boolean {
  if (now - lastPassTime < MIN_PASS_INTERVAL_MS) return false;
  if (currentSegment.audioSamples.length < MIN_AUDIO_SAMPLES) return false;
  return true;
}

/**
 * Append audio samples to a segment's buffer.
 * Caps at MAX_SAMPLES_PER_SEGMENT to prevent unbounded memory growth.
 * Returns the number of samples actually added.
 */
export function appendSamples(
  segment: Segment,
  samples: ArrayLike<number>
): number {
  const remaining = MAX_SAMPLES_PER_SEGMENT - segment.audioSamples.length;
  const toAdd = Math.min(samples.length, remaining);
  for (let i = 0; i < toAdd; i++) {
    segment.audioSamples.push(samples[i]);
  }
  return toAdd;
}

/**
 * Get the duration of a segment's audio in seconds.
 */
export function segmentDurationSec(segment: Segment): number {
  return segment.audioSamples.length / SAMPLE_RATE;
}

/**
 * Create a WAV file buffer from float32 PCM samples.
 * Returns a Uint8Array containing a valid 16-bit 16kHz mono WAV file.
 *
 * This is used to write audio to a temp file for the offline pass,
 * avoiding the React Native bridge overhead of passing 100K+ floats
 * as a JSON array (which caused silent failures for segments > 5s).
 */
export function samplesToWav(samples: number[]): Uint8Array {
  const numSamples = samples.length;
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  const enc = (s: string, off: number) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  enc("RIFF", 0);
  view.setUint32(4, 36 + dataSize, true);
  enc("WAVE", 8);

  // fmt chunk
  enc("fmt ", 12);
  view.setUint32(16, 16, true);       // chunk size
  view.setUint16(20, 1, true);        // PCM format
  view.setUint16(22, 1, true);        // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true);        // block align
  view.setUint16(34, 16, true);       // bits per sample

  // data chunk
  enc("data", 36);
  view.setUint32(40, dataSize, true);

  // Convert float32 [-1, 1] to int16
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

/**
 * Convert a Uint8Array to base64 string.
 * Used for writing binary data through expo-file-system.
 *
 * Uses a manual base64 encoder instead of btoa() because Hermes
 * (React Native's JS engine) doesn't handle binary strings with
 * characters > 127 correctly in btoa(), producing empty or corrupt output.
 */
export function uint8ToBase64(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const len = bytes.length;
  const parts: string[] = [];

  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;

    parts.push(chars[b0 >> 2]);
    parts.push(chars[((b0 & 3) << 4) | (b1 >> 4)]);
    parts.push(i + 1 < len ? chars[((b1 & 15) << 2) | (b2 >> 6)] : "=");
    parts.push(i + 2 < len ? chars[b2 & 63] : "=");
  }

  return parts.join("");
}
