import { applyCorrections, editDistance, CorrectionEntry } from "../correct";

// ── editDistance ──────────────────────────────────────────

describe("editDistance", () => {
  test("identical strings", () => {
    expect(editDistance("metformine", "metformine")).toBe(0);
  });

  test("single substitution", () => {
    expect(editDistance("amiodarone", "amiodarène")).toBe(1);
  });

  test("single insertion", () => {
    expect(editDistance("cardigène", "cardiogène")).toBe(1);
  });

  test("multiple edits", () => {
    expect(editDistance("nandraline", "noradrénaline")).toBe(5);
  });

  test("empty string", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
  });

  test("both empty", () => {
    expect(editDistance("", "")).toBe(0);
  });
});

// ── applyCorrections (exact match) ──────────────────────

describe("applyCorrections - exact match", () => {
  const dict: CorrectionEntry[] = [
    {
      pattern: "hémodialyquement",
      correction: "hémodynamiquement",
      context: ["instable"],
      edit_distance: 2,
    },
  ];

  test("replaces exact match case-insensitively", () => {
    const input = "Le patient arrive hémodialyquement instable";
    const { text, applied } = applyCorrections(input, dict);
    expect(text).toContain("hémodynamiquement");
    expect(applied).toHaveLength(1);
    expect(applied[0].method).toBe("exact");
  });

  test("does not touch text without the pattern", () => {
    const input = "Le patient est stable";
    const { text, applied } = applyCorrections(input, dict);
    expect(text).toBe(input);
    expect(applied).toHaveLength(0);
  });
});

// ── applyCorrections (fuzzy match) ──────────────────────

describe("applyCorrections - fuzzy match", () => {
  const dict: CorrectionEntry[] = [
    {
      pattern: "amiodarone",
      correction: "amiodarone",
      context: ["fibrillation"],
      edit_distance: 2,
    },
  ];

  test("corrects within edit distance threshold", () => {
    const input = "traitement par amiodarène pour fibrillation";
    const { text, applied } = applyCorrections(input, dict);
    expect(text).toContain("amiodarone");
    expect(applied).toHaveLength(1);
    expect(applied[0].method).toMatch(/^fuzzy/);
  });

  test("does not correct beyond edit distance threshold", () => {
    const input = "traitement par amioxyzene pour fibrillation";
    const { text, applied } = applyCorrections(input, dict);
    // "amioxyzene" is too far from "amiodarone"
    expect(text).toContain("amioxyzene");
    expect(applied).toHaveLength(0);
  });
});

// ── applyCorrections (multi-word patterns) ──────────────

describe("applyCorrections - multi-word", () => {
  const dict: CorrectionEntry[] = [
    {
      pattern: "poux perçues",
      correction: "pouls perçus",
      context: ["patient"],
      edit_distance: 2,
    },
    {
      pattern: "sang de satine",
      correction: "sandostatine",
      context: ["traitement"],
      edit_distance: 3,
    },
  ];

  test("replaces multi-word exact patterns", () => {
    const input = "avec des poux perçues et un traitement";
    const { text } = applyCorrections(input, dict);
    expect(text).toContain("pouls perçus");
    expect(text).not.toContain("poux");
  });

  test("replaces 3-word pattern with single word", () => {
    const input = "traitement de sang de satine et quatre culots";
    const { text } = applyCorrections(input, dict);
    expect(text).toContain("sandostatine");
    expect(text).not.toContain("sang de satine");
  });
});

// ── applyCorrections (preserves punctuation) ────────────

describe("applyCorrections - punctuation preservation", () => {
  const dict: CorrectionEntry[] = [
    {
      pattern: "néphrotrique",
      correction: "néphrotique",
      context: ["syndrome"],
      edit_distance: 2,
    },
  ];

  test("preserves trailing period after correction", () => {
    const input = "syndrome néphrotrique.";
    const { text } = applyCorrections(input, dict);
    expect(text).toBe("syndrome néphrotique.");
  });

  test("preserves trailing comma after correction", () => {
    const input = "syndrome néphrotrique, avec";
    const { text } = applyCorrections(input, dict);
    expect(text).toBe("syndrome néphrotique, avec");
  });
});

// ── applyCorrections (multiple corrections in sequence) ─

describe("applyCorrections - sequential", () => {
  const dict: CorrectionEntry[] = [
    {
      pattern: "hémodialyquement",
      correction: "hémodynamiquement",
      edit_distance: 2,
    },
    {
      pattern: "nandraline",
      correction: "noradrénaline",
      edit_distance: 3,
    },
    {
      pattern: "poux perçues",
      correction: "pouls perçus",
      edit_distance: 2,
    },
  ];

  test("applies all corrections without interfering with each other", () => {
    const input =
      "Le patient arrive hémodialyquement instable avec des poux perçues. " +
      "Un soutien par nandraline est débuté.";
    const { text, applied } = applyCorrections(input, dict);
    expect(text).toContain("hémodynamiquement");
    expect(text).toContain("pouls perçus");
    expect(text).toContain("noradrénaline");
    expect(applied).toHaveLength(3);
  });

  test("earlier exact match does not get reverted by later fuzzy pass", () => {
    // This was the actual bug we fixed in correct.py (text/words sync issue).
    // Verify the TypeScript port doesn't have the same problem.
    const input = "hémodialyquement et nandraline";
    const { text } = applyCorrections(input, dict);
    expect(text).toBe("hémodynamiquement et noradrénaline");
  });
});

// ── applyCorrections (context boosting) ─────────────────

describe("applyCorrections - context", () => {
  const dict: CorrectionEntry[] = [
    {
      pattern: "cardigène",
      correction: "cardiogène",
      context: ["choc", "cardiopathie"],
      edit_distance: 2,
    },
  ];

  test("corrects when context word is nearby", () => {
    const input = "tableau de choc cardigène surajouté";
    const { text, applied } = applyCorrections(input, dict);
    expect(text).toContain("cardiogène");
    expect(applied).toHaveLength(1);
  });
});

// ── applyCorrections (with the real corrections.json) ───

describe("applyCorrections - real dictionary", () => {
  // Uses the default corrections.json imported by the module
  test("spike validation: metformine intoxication paragraph", () => {
    const input =
      "Le patient arrive hémodialyquement instable avec des poux perçues. " +
      "Un soutien par nandraline et vasopressine est débuté.";
    const { text } = applyCorrections(input);
    expect(text).toContain("hémodynamiquement");
    expect(text).toContain("pouls perçus");
    expect(text).toContain("noradrénaline");
  });

  test("spike validation: infectiologie paragraph", () => {
    const input =
      "résultats microbiologiques montrent uniquement un spénomynaïe " +
      "que nous traitons par ceftriaxone";
    const { text } = applyCorrections(input);
    expect(text).toContain("S. pneumoniae");
  });

  test("spike validation: insuffisance hépatique paragraph", () => {
    const input =
      "une répression volumique et un soutien aminérgique";
    const { text } = applyCorrections(input);
    expect(text).toContain("réplétion volémique");
    expect(text).toContain("aminergique");
  });
});
