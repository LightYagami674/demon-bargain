import { describe, it, expect } from "vitest";
import {
  generateRoomCode,
  isValidRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from "./constants.js";

describe("Room code generation and validation", () => {
  it("generates 4-letter uppercase codes excluding I, O, and L", () => {
    expect(ROOM_CODE_ALPHABET).not.toContain("I");
    expect(ROOM_CODE_ALPHABET).not.toContain("O");
    expect(ROOM_CODE_ALPHABET).not.toContain("L");

    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect(code).toMatch(/^[A-Z]{4}$/);
      expect(code).not.toMatch(/[IOL]/);
      expect(isValidRoomCode(code)).toBe(true);
    }
  });

  it("rejects codes containing I, O, L, lowercase, or wrong length", () => {
    expect(isValidRoomCode("ABCD")).toBe(true);
    expect(isValidRoomCode("AIBC")).toBe(false);
    expect(isValidRoomCode("AOBC")).toBe(false);
    expect(isValidRoomCode("ALBC")).toBe(false);
    expect(isValidRoomCode("abcd")).toBe(false);
    expect(isValidRoomCode("ABC")).toBe(false);
    expect(isValidRoomCode("ABCDE")).toBe(false);
  });
});
