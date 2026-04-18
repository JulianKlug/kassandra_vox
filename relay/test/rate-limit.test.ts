import { describe, it, expect, beforeEach } from "vitest";
import { isRateLimited, clearAllRateLimits } from "../src/rate-limit.js";

describe("rate-limit", () => {
  beforeEach(() => clearAllRateLimits());

  it("allows messages under the limit", () => {
    for (let i = 0; i < 99; i++) {
      expect(isRateLimited("1.2.3.4")).toBe(false);
    }
  });

  it("blocks at the limit", () => {
    for (let i = 0; i < 100; i++) {
      isRateLimited("1.2.3.4");
    }
    expect(isRateLimited("1.2.3.4")).toBe(true);
  });

  it("tracks IPs independently", () => {
    for (let i = 0; i < 100; i++) {
      isRateLimited("1.1.1.1");
    }
    expect(isRateLimited("1.1.1.1")).toBe(true);
    expect(isRateLimited("2.2.2.2")).toBe(false);
  });
});
