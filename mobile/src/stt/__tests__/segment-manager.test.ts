import {
  createSegment,
  buildTranscript,
  shouldTriggerOfflinePass,
  appendSamples,
  segmentDurationSec,
  samplesToWav,
  uint8ToBase64,
  SAMPLE_RATE,
  MIN_PASS_INTERVAL_MS,
  MIN_AUDIO_SAMPLES,
  MAX_SAMPLES_PER_SEGMENT,
  Segment,
} from "../segment-manager";

// ── createSegment ───────────────────────────────────────

describe("createSegment", () => {
  test("creates a segment with the given index", () => {
    const seg = createSegment(5);
    expect(seg.index).toBe(5);
    expect(seg.streamingText).toBe("");
    expect(seg.offlineText).toBeNull();
    expect(seg.audioSamples).toEqual([]);
  });
});

// ── buildTranscript ─────────────────────────────────────

describe("buildTranscript", () => {
  test("returns empty string when no segments have text", () => {
    const result = buildTranscript([], createSegment(0));
    expect(result).toBe("");
  });

  test("returns streaming text from current segment", () => {
    const current = createSegment(0);
    current.streamingText = "le patient arrive";
    expect(buildTranscript([], current)).toBe("le patient arrive");
  });

  test("prefers offline text over streaming text for finished segments", () => {
    const seg: Segment = {
      index: 0,
      streamingText: "rough text",
      offlineText: "accurate text",
      audioSamples: [],
    };
    const result = buildTranscript([seg], createSegment(1));
    expect(result).toBe("accurate text");
    expect(result).not.toContain("rough");
  });

  test("falls back to streaming text when offline is null", () => {
    const seg: Segment = {
      index: 0,
      streamingText: "rough text",
      offlineText: null,
      audioSamples: [],
    };
    expect(buildTranscript([seg], createSegment(1))).toBe("rough text");
  });

  test("joins multiple segments with '. '", () => {
    const seg0: Segment = { index: 0, streamingText: "segment one", offlineText: null, audioSamples: [] };
    const seg1: Segment = { index: 1, streamingText: "segment two", offlineText: null, audioSamples: [] };
    const current = createSegment(2);
    current.streamingText = "current partial";
    expect(buildTranscript([seg0, seg1], current)).toBe("segment one. segment two. current partial");
  });

  test("skips empty segments", () => {
    const seg0: Segment = { index: 0, streamingText: "first", offlineText: null, audioSamples: [] };
    const seg1: Segment = { index: 1, streamingText: "", offlineText: null, audioSamples: [] };
    const seg2: Segment = { index: 2, streamingText: "third", offlineText: null, audioSamples: [] };
    expect(buildTranscript([seg0, seg1, seg2], createSegment(3))).toBe("first. third");
  });

  test("trims whitespace from segments", () => {
    const seg: Segment = { index: 0, streamingText: "  padded  ", offlineText: null, audioSamples: [] };
    expect(buildTranscript([seg], createSegment(1))).toBe("padded");
  });

  test("does NOT replace streaming text with empty offline text", () => {
    // Previously a bug: ?? doesn't catch "" (not nullish).
    // Fixed: use || to treat empty string as falsy.
    const seg: Segment = {
      index: 0,
      streamingText: "good streaming text",
      offlineText: "",  // empty offline result
      audioSamples: [],
    };
    const result = buildTranscript([seg], createSegment(1));
    expect(result).toBe("good streaming text");
  });
});

// ── shouldTriggerOfflinePass ────────────────────────────

describe("shouldTriggerOfflinePass", () => {
  test("returns false when too soon after last pass", () => {
    const seg = createSegment(0);
    seg.audioSamples = new Array(MIN_AUDIO_SAMPLES).fill(0.1);
    const now = 10_000;
    const lastPassTime = now - 1_000; // 1s ago, need 5s
    expect(shouldTriggerOfflinePass(seg, lastPassTime, now)).toBe(false);
  });

  test("returns false when not enough audio", () => {
    const seg = createSegment(0);
    seg.audioSamples = new Array(SAMPLE_RATE * 0.5).fill(0.1); // 0.5s, need 1s
    const now = 100_000;
    const lastPassTime = 0;
    expect(shouldTriggerOfflinePass(seg, lastPassTime, now)).toBe(false);
  });

  test("returns true when enough time and audio", () => {
    const seg = createSegment(0);
    seg.audioSamples = new Array(MIN_AUDIO_SAMPLES).fill(0.1);
    const now = 100_000;
    const lastPassTime = 0;
    expect(shouldTriggerOfflinePass(seg, lastPassTime, now)).toBe(true);
  });

  test("returns true at exactly the minimum interval", () => {
    const seg = createSegment(0);
    seg.audioSamples = new Array(MIN_AUDIO_SAMPLES).fill(0.1);
    const lastPassTime = 1000;
    const now = lastPassTime + MIN_PASS_INTERVAL_MS;
    expect(shouldTriggerOfflinePass(seg, lastPassTime, now)).toBe(true);
  });

  test("returns false at one ms before the minimum interval", () => {
    const seg = createSegment(0);
    seg.audioSamples = new Array(MIN_AUDIO_SAMPLES).fill(0.1);
    const lastPassTime = 1000;
    const now = lastPassTime + MIN_PASS_INTERVAL_MS - 1;
    expect(shouldTriggerOfflinePass(seg, lastPassTime, now)).toBe(false);
  });
});

// ── appendSamples ───────────────────────────────────────

describe("appendSamples", () => {
  test("appends samples to empty segment", () => {
    const seg = createSegment(0);
    const added = appendSamples(seg, [0.1, 0.2, 0.3]);
    expect(added).toBe(3);
    expect(seg.audioSamples).toEqual([0.1, 0.2, 0.3]);
  });

  test("appends to existing samples", () => {
    const seg = createSegment(0);
    seg.audioSamples = [0.1, 0.2];
    appendSamples(seg, [0.3, 0.4]);
    expect(seg.audioSamples).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  test("caps at MAX_SAMPLES_PER_SEGMENT", () => {
    const seg = createSegment(0);
    seg.audioSamples = new Array(MAX_SAMPLES_PER_SEGMENT - 2).fill(0);
    const added = appendSamples(seg, [1, 2, 3, 4, 5]);
    expect(added).toBe(2); // only 2 slots remaining
    expect(seg.audioSamples.length).toBe(MAX_SAMPLES_PER_SEGMENT);
  });

  test("returns 0 when segment is already at max", () => {
    const seg = createSegment(0);
    seg.audioSamples = new Array(MAX_SAMPLES_PER_SEGMENT).fill(0);
    const added = appendSamples(seg, [1, 2, 3]);
    expect(added).toBe(0);
    expect(seg.audioSamples.length).toBe(MAX_SAMPLES_PER_SEGMENT);
  });

  test("works with Float32Array input", () => {
    const seg = createSegment(0);
    const samples = new Float32Array([0.5, -0.5, 0.0]);
    const added = appendSamples(seg, samples);
    expect(added).toBe(3);
    expect(seg.audioSamples[0]).toBeCloseTo(0.5);
    expect(seg.audioSamples[1]).toBeCloseTo(-0.5);
  });
});

// ── segmentDurationSec ──────────────────────────────────

describe("segmentDurationSec", () => {
  test("returns 0 for empty segment", () => {
    expect(segmentDurationSec(createSegment(0))).toBe(0);
  });

  test("returns correct duration for 1 second of audio", () => {
    const seg = createSegment(0);
    seg.audioSamples = new Array(SAMPLE_RATE).fill(0);
    expect(segmentDurationSec(seg)).toBe(1);
  });

  test("returns correct duration for 5.5 seconds of audio", () => {
    const seg = createSegment(0);
    seg.audioSamples = new Array(SAMPLE_RATE * 5.5).fill(0);
    expect(segmentDurationSec(seg)).toBeCloseTo(5.5);
  });
});

// ── samplesToWav ────────────────────────────────────────

describe("samplesToWav", () => {
  test("produces a valid WAV header", () => {
    const wav = samplesToWav([0, 0, 0, 0]);
    // RIFF header
    expect(String.fromCharCode(wav[0], wav[1], wav[2], wav[3])).toBe("RIFF");
    // WAVE format
    expect(String.fromCharCode(wav[8], wav[9], wav[10], wav[11])).toBe("WAVE");
    // fmt chunk
    expect(String.fromCharCode(wav[12], wav[13], wav[14], wav[15])).toBe("fmt ");
    // data chunk
    expect(String.fromCharCode(wav[36], wav[37], wav[38], wav[39])).toBe("data");
  });

  test("header specifies 16kHz mono 16-bit PCM", () => {
    const wav = samplesToWav([0]);
    const view = new DataView(wav.buffer);
    expect(view.getUint16(20, true)).toBe(1);      // PCM format
    expect(view.getUint16(22, true)).toBe(1);      // mono
    expect(view.getUint32(24, true)).toBe(16000);  // sample rate
    expect(view.getUint16(34, true)).toBe(16);     // bits per sample
  });

  test("total file size is 44 + numSamples * 2", () => {
    const samples = [0.1, -0.5, 0.8, -1.0];
    const wav = samplesToWav(samples);
    expect(wav.length).toBe(44 + samples.length * 2);
  });

  test("data chunk size matches sample count", () => {
    const samples = new Array(100).fill(0.5);
    const wav = samplesToWav(samples);
    const view = new DataView(wav.buffer);
    expect(view.getUint32(40, true)).toBe(100 * 2); // data size
  });

  test("clamps samples to [-1, 1]", () => {
    const wav = samplesToWav([2.0, -2.0]);
    const view = new DataView(wav.buffer);
    // 2.0 clamped to 1.0 -> 32767
    expect(view.getInt16(44, true)).toBe(32767);
    // -2.0 clamped to -1.0 -> -32768
    expect(view.getInt16(46, true)).toBe(-32768);
  });

  test("silence produces zeros", () => {
    const wav = samplesToWav([0, 0, 0]);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(0);
  });

  test("handles large segment (10 seconds, 160K samples)", () => {
    const samples = new Array(SAMPLE_RATE * 10).fill(0.1);
    const wav = samplesToWav(samples);
    expect(wav.length).toBe(44 + SAMPLE_RATE * 10 * 2);
    // Verify RIFF size field
    const view = new DataView(wav.buffer);
    expect(view.getUint32(4, true)).toBe(36 + SAMPLE_RATE * 10 * 2);
  });
});

// ── uint8ToBase64 ───────────────────────────────────────

describe("uint8ToBase64", () => {
  test("encodes empty array", () => {
    expect(uint8ToBase64(new Uint8Array([]))).toBe("");
  });

  test("encodes known values", () => {
    // "Hello" in ASCII
    const bytes = new Uint8Array([72, 101, 108, 108, 111]);
    expect(uint8ToBase64(bytes)).toBe(btoa("Hello"));
  });

  test("round-trips through atob", () => {
    const original = new Uint8Array([0, 1, 127, 128, 255]);
    const b64 = uint8ToBase64(original);
    const decoded = atob(b64);
    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decoded.charCodeAt(i)).toBe(original[i]);
    }
  });

  test("handles data larger than chunk size (8192)", () => {
    const bytes = new Uint8Array(10000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const b64 = uint8ToBase64(bytes);
    const decoded = atob(b64);
    expect(decoded.length).toBe(10000);
    expect(decoded.charCodeAt(0)).toBe(0);
    expect(decoded.charCodeAt(8191)).toBe(8191 % 256);
    expect(decoded.charCodeAt(8192)).toBe(8192 % 256);
  });
});

// ── file:// URI stripping (tested via logic, not the actual function) ──

describe("file URI handling", () => {
  test("file:// prefix should be stripped for native code", () => {
    const uri = "file:///data/user/0/com.vox.dictation/cache/test.wav";
    const plain = uri.replace(/^file:\/\//, "");
    expect(plain).toBe("/data/user/0/com.vox.dictation/cache/test.wav");
    expect(plain).not.toContain("file://");
  });

  test("plain path without file:// is unchanged", () => {
    const path = "/data/user/0/com.vox.dictation/cache/test.wav";
    const result = path.replace(/^file:\/\//, "");
    expect(result).toBe(path);
  });
});

// ── Integration: buildTranscript with offlineText="" ────

describe("buildTranscript empty offline bug", () => {
  // This test documents the actual bug we need to fix:
  // When offlineText is "" (empty string from a failed pass),
  // ?? doesn't catch it because "" is not null/undefined.
  // The fix: either use || instead of ??, or explicitly check
  // for empty strings before assigning offlineText.

  test("FIXED: empty offlineText falls back to streaming text", () => {
    const seg: Segment = {
      index: 0,
      streamingText: "noradrénaline et vasopressine",
      offlineText: "",
      audioSamples: [],
    };
    const result = buildTranscript([seg], createSegment(1));
    expect(result).toBe("noradrénaline et vasopressine");
  });
});
