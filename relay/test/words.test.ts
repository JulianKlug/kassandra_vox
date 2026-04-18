import { describe, it, expect } from "vitest";
import { generateRoomCode, isValidRoomCode } from "../src/words.js";

describe("words", () => {
  it("generates valid room codes", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      expect(isValidRoomCode(code)).toBe(true);
    }
  });

  it("generates codes with two different words", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      const [w1, w2] = code.split("-");
      expect(w1).not.toBe(w2);
    }
  });

  it("validates correct codes", () => {
    expect(isValidRoomCode("BLEU-TIGRE-42")).toBe(true);
    expect(isValidRoomCode("NORD-SUD-10")).toBe(true);
  });

  it("rejects invalid codes", () => {
    expect(isValidRoomCode("")).toBe(false);
    expect(isValidRoomCode("bleu-tigre-42")).toBe(false); // lowercase
    expect(isValidRoomCode("BLEU-42")).toBe(false); // missing word
    expect(isValidRoomCode("BLEU-TIGRE-1")).toBe(false); // single digit
    expect(isValidRoomCode("BLEU-TIGRE-100")).toBe(false); // 3 digits
  });
});
