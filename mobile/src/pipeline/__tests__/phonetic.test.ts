import { frenchPhoneticKey, findPhoneticMatch, applyPhoneticCorrections } from "../phonetic";

describe("frenchPhoneticKey", () => {
  it("normalizes accents", () => {
    expect(frenchPhoneticKey("hémodynamique")).toBe(frenchPhoneticKey("hemodynamique"));
  });

  it("collapses ph to f", () => {
    expect(frenchPhoneticKey("phosphore")).toContain("f");
    expect(frenchPhoneticKey("phosphore")).not.toContain("ph");
  });

  it("handles nasal vowels", () => {
    // "an" and "en" both map to nasal "A"
    const k1 = frenchPhoneticKey("antérieur");
    const k2 = frenchPhoneticKey("entérieur");
    expect(k1).toBe(k2);
  });

  it("handles ch → S", () => {
    expect(frenchPhoneticKey("choc")).toContain("S");
  });

  it("produces similar keys for similar-sounding words", () => {
    const k1 = frenchPhoneticKey("noradrénaline");
    const k2 = frenchPhoneticKey("nordrénaline");
    // Should be close (small edit distance between keys)
    const dist = levenshtein(k1, k2);
    expect(dist).toBeLessThanOrEqual(3);
  });

  it("produces different keys for different-sounding words", () => {
    const k1 = frenchPhoneticKey("cathéter");
    const k2 = frenchPhoneticKey("albumine");
    expect(k1).not.toBe(k2);
  });
});

describe("findPhoneticMatch", () => {
  it("matches common STT errors to medical terms", () => {
    // "hipatique" → "hépatique"
    const match = findPhoneticMatch("hipatique");
    expect(match).not.toBeNull();
    expect(match!.match).toBe("hépatique");
  });

  it("matches drug name errors", () => {
    // "amiodarène" → "amiodarone"
    const match = findPhoneticMatch("amiodarène");
    expect(match).not.toBeNull();
    expect(match!.match).toBe("amiodarone");
  });

  it("skips common French words", () => {
    const match = findPhoneticMatch("patient");
    expect(match).toBeNull();
  });

  it("skips short words", () => {
    const match = findPhoneticMatch("le");
    expect(match).toBeNull();
  });

  it("skips words already in vocab", () => {
    const match = findPhoneticMatch("cathéter");
    expect(match).toBeNull();
  });

  it("returns confidence score", () => {
    const match = findPhoneticMatch("hipatique");
    if (match) {
      expect(match.confidence).toBeGreaterThan(0);
      expect(match.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("applyPhoneticCorrections", () => {
  it("corrects unknown medical terms in context", () => {
    const result = applyPhoneticCorrections(
      "nous retenons une insuffisance hipatique"
    );
    expect(result.text).toContain("hépatique");
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("preserves correct words", () => {
    const result = applyPhoneticCorrections(
      "le patient arrive aux soins intensifs"
    );
    expect(result.text).toBe("le patient arrive aux soins intensifs");
    expect(result.matches.length).toBe(0);
  });

  it("preserves punctuation", () => {
    const result = applyPhoneticCorrections(
      "insuffisance hipatique, nous débutons"
    );
    expect(result.text).toContain(",");
  });
});

// Helper for tests
function levenshtein(a: string, b: string): number {
  if (a.length < b.length) return levenshtein(b, a);
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const curr = [i + 1];
    for (let j = 0; j < b.length; j++) {
      curr[j + 1] = Math.min(curr[j] + 1, prev[j + 1] + 1, prev[j] + (a[i] === b[j] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[b.length];
}
