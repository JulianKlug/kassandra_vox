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
// Offline pass regresses worst on short clips (multilingual CTC misfires,
// list-style segments). Streaming text is good enough on short utterances.
export const MIN_AUDIO_SAMPLES = SAMPLE_RATE * 3; // 3 seconds
export const MAX_NO_PASS_MS = 30_000;
export const MAX_SAMPLES_PER_SEGMENT = SAMPLE_RATE * 60; // 60 seconds cap

// Offline-pass quality gates: reject offline output that looks structurally
// wrong before it overrides streaming text. See docs/specs/offline-pass-quality-gate.md
export const FRENCH_STOPWORDS = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du",
  "et", "ou", "à", "au", "aux", "en", "dans", "sur",
  "pour", "par", "avec", "sans", "est", "sont", "n'",
  "ne", "pas", "plus", "que", "qui", "ce", "cette",
  "ces", "je", "tu", "il", "elle", "on", "nous", "vous",
  "ils", "elles", "se", "sa", "son", "ses", "mon", "ma",
  "mes", "lui", "leur", "leurs", "y",
]);
export const STOPWORD_CHECK_MIN_WORDS = 5;
export const LENGTH_RATIO_MIN = 0.5;
export const LENGTH_RATIO_MAX = 2.0;

export interface Segment {
  index: number;
  streamingText: string;
  offlineText: string | null;
  audioSamples: number[];
}

export interface OfflineGateDecision {
  text: string;
  source: "offline" | "streaming-fallback";
  rejectionReason?: "empty" | "no-french-stopword" | "length-mismatch";
}

export function createSegment(index: number): Segment {
  return { index, streamingText: "", offlineText: null, audioSamples: [] };
}

/**
 * Check that text contains at least one French stopword. Catches the
 * multilingual-CTC misfire mode where the model falls back to en/de/es phonemes.
 *
 * Short medical-term lists ("noradrénaline dobutamine") legitimately contain no
 * stopwords, so the check is skipped under STOPWORD_CHECK_MIN_WORDS.
 */
export function hasFrenchStopword(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .split(/[\s,.;:!?'"()]+/)
    .filter((t) => t.length > 0);
  if (tokens.length < STOPWORD_CHECK_MIN_WORDS) return true;
  return tokens.some((t) => FRENCH_STOPWORDS.has(t));
}

/**
 * Check that offline word count is within [0.5x, 2.0x] of streaming.
 * Catches truncations and hallucination loops.
 */
export function isLengthRatioOk(streaming: string, offline: string): boolean {
  const streamingWords = streaming.trim().split(/\s+/).filter(Boolean).length;
  const offlineWords = offline.trim().split(/\s+/).filter(Boolean).length;
  if (streamingWords === 0) return true;
  const ratio = offlineWords / streamingWords;
  return ratio >= LENGTH_RATIO_MIN && ratio <= LENGTH_RATIO_MAX;
}

/**
 * Decide whether offline text should override streaming text. Runs three gates:
 * empty → French stopword check → length-ratio sanity check.
 */
export function gateOfflineText(
  streamingText: string,
  offlineText: string | null
): OfflineGateDecision {
  const offline = offlineText?.trim() ?? "";
  const streaming = streamingText.trim();

  if (!offline) {
    return { text: streaming, source: "streaming-fallback", rejectionReason: "empty" };
  }
  if (!hasFrenchStopword(offline)) {
    return { text: streaming, source: "streaming-fallback", rejectionReason: "no-french-stopword" };
  }
  if (!isLengthRatioOk(streaming, offline)) {
    return { text: streaming, source: "streaming-fallback", rejectionReason: "length-mismatch" };
  }
  return { text: offline, source: "offline" };
}

/**
 * Build the full transcript from finished segments + current in-progress segment.
 * Prefers offline text when it passes the quality gates, falls back to streaming.
 */
export function buildTranscript(
  finishedSegments: Segment[],
  currentSegment: Segment
): string {
  const parts: string[] = [];
  for (const seg of finishedSegments) {
    const decision = gateOfflineText(seg.streamingText, seg.offlineText);
    if (decision.text) parts.push(decision.text);
    if (decision.rejectionReason && decision.rejectionReason !== "empty") {
      console.log(
        `[vox] Offline rejected (${decision.rejectionReason}) seg #${seg.index}: "${seg.offlineText?.slice(0, 60)}"`
      );
    }
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
 * Add dithering (tiny random noise) to audio samples.
 *
 * Workaround for sherpa-onnx Canary empty results: the C++ code
 * hardcodes dither=0 for Canary (offline-recognizer-canary-impl.h),
 * overriding any user setting. Without dithering, clean digital audio
 * can produce exact-zero values in the mel feature extractor, which
 * causes the NeMo encoder to produce empty output (issue #2258).
 *
 * We apply dithering at the application level before writing the WAV.
 */
export function addDither(samples: number[], amount: number = 0.00001): number[] {
  const result = new Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    // Gaussian-ish noise via Box-Muller (cheap approximation)
    const u1 = Math.random();
    const u2 = Math.random();
    const noise = Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
    result[i] = samples[i] + noise * amount;
  }
  return result;
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

// Re-export from shared util for backwards compatibility
export { uint8ToBase64 } from "../utils/base64";
