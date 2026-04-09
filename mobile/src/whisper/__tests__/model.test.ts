import {
  getModelPath,
  getModelInfo,
  ModelVariant,
} from "../model";

describe("model utilities", () => {
  test("getModelPath returns correct path for large-v3", () => {
    const path = getModelPath("large-v3");
    expect(path).toContain("models/");
    expect(path).toContain("ggml-large-v3.bin");
  });

  test("getModelPath returns correct path for medium", () => {
    const path = getModelPath("medium");
    expect(path).toContain("models/");
    expect(path).toContain("ggml-medium.bin");
  });

  test("getModelInfo returns size for large-v3", () => {
    const info = getModelInfo("large-v3");
    expect(info.sizeLabel).toBe("2.9 GB");
    expect(info.sizeBytes).toBeGreaterThan(2_000_000_000);
    expect(info.url).toContain("huggingface.co");
    expect(info.filename).toBe("ggml-large-v3.bin");
  });

  test("getModelInfo returns size for medium", () => {
    const info = getModelInfo("medium");
    expect(info.sizeLabel).toBe("1.5 GB");
    expect(info.sizeBytes).toBeGreaterThan(1_000_000_000);
    expect(info.sizeBytes).toBeLessThan(2_000_000_000);
  });

  test("medium is smaller than large-v3", () => {
    const medium = getModelInfo("medium");
    const large = getModelInfo("large-v3");
    expect(medium.sizeBytes).toBeLessThan(large.sizeBytes);
  });

  test("model variants have different filenames", () => {
    const variants: ModelVariant[] = ["large-v3", "medium"];
    const filenames = variants.map((v) => getModelInfo(v).filename);
    expect(new Set(filenames).size).toBe(variants.length);
  });

  test("model URLs point to ggml files", () => {
    const variants: ModelVariant[] = ["large-v3", "medium"];
    for (const v of variants) {
      const info = getModelInfo(v);
      expect(info.url).toMatch(/ggml-.*\.bin$/);
    }
  });
});
