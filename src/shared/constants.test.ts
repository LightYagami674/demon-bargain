import { describe, it, expect } from "vitest";
import {
  ROUND_DURATION_MS,
  generateRoomCode,
  getRoundDurationMs,
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

describe("Round duration pacing", () => {
  it("uses a fixed 2-minute (120_000ms) round duration across 2–6 players", () => {
    expect(ROUND_DURATION_MS).toBe(120_000);
    expect(getRoundDurationMs(2, 2)).toBe(120_000);
    for (let living = 2; living <= 6; living++) {
      expect(getRoundDurationMs(living, 6)).toBe(120_000);
    }
  });
});
