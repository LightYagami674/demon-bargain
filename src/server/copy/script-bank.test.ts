import { describe, expect, it } from "vitest";
import { ENTITY_MOODS } from "../jev.js";
import {
  BEAT_POOLS,
  MOOD_HINT_POOLS,
  POST_MATCH_JUDGE_ERROR,
  type BeatPoolName,
} from "./script-bank.js";
import { EntityCopyEngine } from "./copy-engine.js";

const EXPECTED_BEAT_POOLS: BeatPoolName[] = [
  "ROUND_INTRO_FIRST",
  "ROUND_INTRO_NEXT",
  "ROUND_INTRO_SUDDEN_DEATH",
  "ROUND_RESOLVING",
  "SACRIFICE_TIMER",
  "SACRIFICE_SPIKE",
  "SACRIFICE_DISCONNECT",
  "SACRIFICE_TIEBREAK",
  "SPAM_MOCKERY",
  "WHISPER_LEAK",
  "CURSE_PASS_SINGLE",
  "CURSE_FAIL_SINGLE",
  "CURSE_PASS_MULTI",
  "CURSE_FAIL_MULTI",
  "CURSE_MIXED_MULTI",
  "POST_MATCH_SURVIVOR",
  "POST_MATCH_ALL_CLAIMED",
];

describe("Curated 162-line Entity script bank", () => {
  it("contains all 60 Mood hints (6 Moods x 10 lines, <= 85 chars, plain text, unique)", () => {
    expect(Object.keys(MOOD_HINT_POOLS).sort()).toEqual([...ENTITY_MOODS].sort());

    let totalHints = 0;
    for (const mood of ENTITY_MOODS) {
      const pool = MOOD_HINT_POOLS[mood];
      expect(pool).toHaveLength(10);
      expect(new Set(pool).size).toBe(10);
      for (const line of pool) {
        expect(line.length).toBeGreaterThan(0);
        expect(line.length).toBeLessThanOrEqual(85);
        expect(line).not.toMatch(/[*_`#]/);
        expect(line).not.toMatch(/\{[a-zA-Z0-9_]+\}/);
      }
      totalHints += pool.length;
    }
    expect(totalHints).toBe(60);
  });

  it("contains all 102 beat templates (17 pools x 6 lines, <= 110 chars, unique) plus fixed JUDGE_ERROR", () => {
    expect(Object.keys(BEAT_POOLS).sort()).toEqual([...EXPECTED_BEAT_POOLS].sort());

    let totalBeats = 0;
    for (const poolName of EXPECTED_BEAT_POOLS) {
      const pool = BEAT_POOLS[poolName];
      expect(pool).toHaveLength(6);
      expect(new Set(pool).size).toBe(6);
      for (const template of pool) {
        expect(template.length).toBeGreaterThan(0);
        expect(template.length).toBeLessThanOrEqual(110);
        expect(template).not.toMatch(/[*_`#]/);
      }
      totalBeats += pool.length;
    }
    expect(totalBeats).toBe(102);
    expect(totalBeats + 60).toBe(162);
    expect(POST_MATCH_JUDGE_ERROR).toBe("The Entity fell silent — Match aborted");
  });
});

describe("EntityCopyEngine shuffle-bag & interpolation", () => {
  it("draws every Mood hint in a pool before repeating and avoids immediate boundary repeats", () => {
    let seed = 0.13;
    const rng = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const engine = new EntityCopyEngine(rng);

    const firstDeck: string[] = [];
    for (let i = 0; i < 10; i++) {
      firstDeck.push(engine.drawMoodHint("SADIST"));
    }
    expect(new Set(firstDeck).size).toBe(10);
    expect(new Set(firstDeck)).toEqual(new Set(MOOD_HINT_POOLS.SADIST));

    const boundaryNext = engine.drawMoodHint("SADIST");
    expect(boundaryNext).not.toBe(firstDeck[9]);

    const secondDeck = [boundaryNext];
    for (let i = 1; i < 10; i++) {
      secondDeck.push(engine.drawMoodHint("SADIST"));
    }
    expect(new Set(secondDeck).size).toBe(10);
  });

  it("draws every beat in a pool before repeating and avoids immediate boundary repeats", () => {
    const engine = new EntityCopyEngine(() => 0.5);

    const firstDeck: string[] = [];
    for (let i = 0; i < 6; i++) {
      firstDeck.push(engine.drawBeat("ROUND_RESOLVING"));
    }
    expect(new Set(firstDeck).size).toBe(6);
    expect(new Set(firstDeck)).toEqual(new Set(BEAT_POOLS.ROUND_RESOLVING));

    const boundaryNext = engine.drawBeat("ROUND_RESOLVING");
    expect(boundaryNext).not.toBe(firstDeck[5]);
  });

  it("interpolates all placeholders server-side with zero raw tokens remaining and no double-substitution", () => {
    const engine = new EntityCopyEngine(() => 0.25);

    const whisper = engine.drawBeat("WHISPER_LEAK", {
      player: "Alice",
      target: "Bob",
    });
    expect(whisper).toContain("Alice");
    expect(whisper).toContain("Bob");
    expect(whisper).not.toMatch(/\{[a-zA-Z0-9_]+\}/);

    const curseMixed = engine.drawCurseBeat("Mallory", ["shadow"], ["knife", "ash"]);
    expect(curseMixed).toContain("Mallory");
    expect(curseMixed).toContain("1");
    expect(curseMixed).toContain("2");
    expect(curseMixed).not.toMatch(/\{[a-zA-Z0-9_]+\}/);

    // Player name containing `{word}` must not be double-substituted
    const curseSingle = engine.drawCurseBeat("{word}", [], ["blood"]);
    expect(curseSingle).toContain("{word}");
    expect(curseSingle).toContain("blood");
  });

  it("preserves shuffle-bag state across serialize/restore", () => {
    const engine = new EntityCopyEngine(() => 0.37);
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      seen.add(engine.drawBeat("SPAM_MOCKERY", { player: "Alice" }));
    }

    const saved = engine.serialize();
    const restored = new EntityCopyEngine(() => 0.37, saved);
    for (let i = 0; i < 2; i++) {
      seen.add(restored.drawBeat("SPAM_MOCKERY", { player: "Alice" }));
    }
    expect(seen.size).toBe(6);
  });
});
