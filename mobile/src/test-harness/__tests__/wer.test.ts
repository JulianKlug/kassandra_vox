import {
  computeWer,
  computeAggregateWer,
  normalizeForWer,
  formatWer,
} from "../wer";

// ── normalizeForWer ─────────────────────────────────────

describe("normalizeForWer", () => {
  test("lowercases text", () => {
    expect(normalizeForWer("Le Patient")).toBe("le patient");
  });

  test("removes punctuation", () => {
    expect(normalizeForWer("bonjour, monde! test.")).toBe("bonjour monde test");
  });

  test("collapses multiple spaces", () => {
    expect(normalizeForWer("a  b   c")).toBe("a b c");
  });

  test("trims leading and trailing whitespace", () => {
    expect(normalizeForWer("  hello  ")).toBe("hello");
  });

  test("handles French accents (preserves them)", () => {
    expect(normalizeForWer("hémodynamiquement")).toBe("hémodynamiquement");
  });

  test("removes dashes and brackets", () => {
    expect(normalizeForWer("N-acétylcystéine (NAC)")).toBe("n acétylcystéine nac");
  });
});

// ── computeWer (basic) ──────────────────────────────────

describe("computeWer - basic", () => {
  test("identical strings give 0% WER", () => {
    const result = computeWer("le patient arrive", "le patient arrive");
    expect(result.wer).toBe(0);
    expect(result.substitutions).toBe(0);
    expect(result.insertions).toBe(0);
    expect(result.deletions).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  test("completely different strings give high WER", () => {
    const result = computeWer("bonjour monde", "abc def");
    expect(result.wer).toBe(1); // 2 subs / 2 words
    expect(result.substitutions).toBe(2);
  });

  test("empty reference with non-empty hypothesis", () => {
    const result = computeWer("", "some text");
    expect(result.wer).toBe(1);
    expect(result.insertions).toBe(2);
  });

  test("empty hypothesis with non-empty reference", () => {
    const result = computeWer("some text", "");
    expect(result.wer).toBe(1); // 2 deletions / 2 words
    expect(result.deletions).toBe(2);
  });

  test("both empty gives 0% WER", () => {
    const result = computeWer("", "");
    expect(result.wer).toBe(0);
  });
});

// ── computeWer (error types) ────────────────────────────

describe("computeWer - error types", () => {
  test("single substitution", () => {
    const result = computeWer(
      "le patient arrive",
      "le malade arrive"
    );
    expect(result.wer).toBeCloseTo(1 / 3);
    expect(result.substitutions).toBe(1);
    expect(result.errors[0].type).toBe("substitution");
    expect(result.errors[0].reference).toBe("patient");
    expect(result.errors[0].hypothesis).toBe("malade");
  });

  test("single insertion", () => {
    const result = computeWer(
      "le patient arrive",
      "le patient arrive ici"
    );
    expect(result.wer).toBeCloseTo(1 / 3);
    expect(result.insertions).toBe(1);
  });

  test("single deletion", () => {
    const result = computeWer(
      "le patient arrive ici",
      "le patient arrive"
    );
    expect(result.wer).toBeCloseTo(1 / 4);
    expect(result.deletions).toBe(1);
  });

  test("mixed errors", () => {
    const result = computeWer(
      "le patient arrive hémodynamiquement instable",
      "le malade arrive instable"
    );
    // "patient" -> "malade" (sub), "hémodynamiquement" deleted
    expect(result.substitutions).toBe(1);
    expect(result.deletions).toBe(1);
    expect(result.wer).toBeCloseTo(2 / 5);
  });
});

// ── computeWer (case insensitive + punctuation) ─────────

describe("computeWer - normalization", () => {
  test("case differences don't count as errors", () => {
    const result = computeWer("Le Patient", "le patient");
    expect(result.wer).toBe(0);
  });

  test("punctuation differences don't count as errors", () => {
    const result = computeWer(
      "bonjour, monde!",
      "bonjour monde"
    );
    expect(result.wer).toBe(0);
  });

  test("accents DO count (they change meaning in French)", () => {
    const result = computeWer("metformine", "métformine");
    // These are different words after normalization
    expect(result.wer).toBe(1); // 1 sub / 1 word
  });
});

// ── computeWer (medical French examples) ────────────────

describe("computeWer - medical French", () => {
  test("spike example: metformine paragraph", () => {
    const reference =
      "Le patient arrive hémodynamiquement instable avec des pouls percus. " +
      "Un soutien par noradrenaline et vasopressine est débuté.";
    const hypothesis =
      "Le patient arrive hémodialyquement instable avec des poux perçues. " +
      "Un soutien par nandraline et vasopressine est débuté.";
    const result = computeWer(reference, hypothesis);
    // "hémodynamiquement" -> "hémodialyquement" (sub)
    // "pouls" -> "poux" (sub)
    // "percus" -> "perçues" (sub)
    // "noradrenaline" -> "nandraline" (sub)
    expect(result.substitutions).toBeGreaterThanOrEqual(3);
    expect(result.wer).toBeGreaterThan(0);
    expect(result.wer).toBeLessThan(0.5); // should be well under 50%
  });

  test("perfect transcription gives 0% WER", () => {
    const text = "tension artérielle 138/82 mmHg fréquence cardiaque 72 bpm";
    const result = computeWer(text, text);
    expect(result.wer).toBe(0);
  });
});

// ── computeAggregateWer ─────────────────────────────────

describe("computeAggregateWer", () => {
  test("aggregates multiple pairs", () => {
    const result = computeAggregateWer([
      { reference: "le patient", hypothesis: "le malade" },     // 1 sub / 2 words
      { reference: "arrive ici", hypothesis: "arrive ici" },     // 0 / 2 words
    ]);
    expect(result.wer).toBeCloseTo(1 / 4); // 1 error in 4 total words
    expect(result.referenceWords).toBe(4);
    expect(result.substitutions).toBe(1);
  });

  test("empty pairs list gives 0% WER", () => {
    const result = computeAggregateWer([]);
    expect(result.wer).toBe(0);
  });
});

// ── formatWer ───────────────────────────────────────────

describe("formatWer", () => {
  test("formats result as readable string", () => {
    const result = computeWer("a b c d", "a x c");
    const formatted = formatWer(result);
    expect(formatted).toContain("WER:");
    expect(formatted).toContain("%");
    expect(formatted).toContain("4 words");
  });

  test("0% WER formats correctly", () => {
    const result = computeWer("hello", "hello");
    expect(formatWer(result)).toContain("0.0%");
  });
});
