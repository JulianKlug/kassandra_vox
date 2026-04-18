import { generateRoomCode } from "../room-codes";

describe("room-codes", () => {
  it("generates codes in WORD-WORD-NN format", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      expect(code).toMatch(/^[A-Z]+-[A-Z]+-\d{2}$/);
    }
  });

  it("generates two different words", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      const [w1, w2] = code.split("-");
      expect(w1).not.toBe(w2);
    }
  });

  it("generates 2-digit numbers (10-99)", () => {
    const nums = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      const num = parseInt(code.split("-")[2], 10);
      expect(num).toBeGreaterThanOrEqual(10);
      expect(num).toBeLessThanOrEqual(99);
      nums.add(num);
    }
    // Should see some variety in 200 draws
    expect(nums.size).toBeGreaterThan(5);
  });

  it("generates uppercase codes", () => {
    const code = generateRoomCode();
    expect(code).toBe(code.toUpperCase());
  });
});
