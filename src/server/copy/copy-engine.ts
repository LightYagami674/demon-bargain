import type { EntityMood } from "../jev.js";
import {
  BEAT_POOLS,
  MOOD_HINT_POOLS,
  type BeatPoolName,
} from "./script-bank.js";

export interface CopyVariables {
  player?: string;
  target?: string;
  word?: string;
  count?: number;
  passedCount?: number;
  failedCount?: number;
}

export interface SerializedCopyEngineState {
  bags: Record<string, number[]>;
  lastDrawn: Record<string, number>;
}

function interpolateTemplate(template: string, vars?: CopyVariables): string {
  if (!vars) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const value = (vars as Record<string, string | number | undefined>)[key];
    return value !== undefined ? String(value) : match;
  });
}

/**
 * Per-Match shuffle-bag copy engine for the curated Entity script bank.
 * Guarantees zero repetition within a pool until exhaustion and avoids
 * immediate repeats across reshuffle boundaries.
 */
export class EntityCopyEngine {
  private bags = new Map<string, number[]>();
  private lastDrawn = new Map<string, number>();

  constructor(
    private readonly random: () => number,
    initialState?: SerializedCopyEngineState,
  ) {
    if (initialState) {
      this.restore(initialState);
    }
  }

  reset(): void {
    this.bags.clear();
    this.lastDrawn.clear();
  }

  restore(state: SerializedCopyEngineState): void {
    this.bags = new Map(
      Object.entries(state.bags).map(([k, v]) => [k, [...v]]),
    );
    this.lastDrawn = new Map(Object.entries(state.lastDrawn));
  }

  serialize(): SerializedCopyEngineState {
    const bags: Record<string, number[]> = {};
    for (const [k, v] of this.bags.entries()) {
      bags[k] = [...v];
    }
    const lastDrawn: Record<string, number> = {};
    for (const [k, v] of this.lastDrawn.entries()) {
      lastDrawn[k] = v;
    }
    return { bags, lastDrawn };
  }

  drawMoodHint(mood: EntityMood): string {
    const pool = MOOD_HINT_POOLS[mood];
    return this.drawFromPool(`mood:${mood}`, pool);
  }

  drawBeat(poolName: BeatPoolName, vars?: CopyVariables): string {
    const pool = BEAT_POOLS[poolName];
    const template = this.drawFromPool(`beat:${poolName}`, pool);
    return interpolateTemplate(template, vars);
  }

  drawCurseBeat(
    playerName: string,
    passedWords: readonly string[],
    failedWords: readonly string[],
  ): string {
    const passedCount = passedWords.length;
    const failedCount = failedWords.length;
    const totalCount = passedCount + failedCount;

    if (totalCount === 1) {
      if (passedCount === 1) {
        return this.drawBeat("CURSE_PASS_SINGLE", {
          player: playerName,
          word: passedWords[0]!,
        });
      }
      return this.drawBeat("CURSE_FAIL_SINGLE", {
        player: playerName,
        word: failedWords[0]!,
      });
    }

    if (failedCount === 0) {
      return this.drawBeat("CURSE_PASS_MULTI", {
        player: playerName,
        count: totalCount,
      });
    }
    if (passedCount === 0) {
      return this.drawBeat("CURSE_FAIL_MULTI", {
        player: playerName,
        count: totalCount,
      });
    }
    return this.drawBeat("CURSE_MIXED_MULTI", {
      player: playerName,
      passedCount,
      failedCount,
    });
  }

  private drawFromPool(key: string, pool: readonly string[]): string {
    let bag = this.bags.get(key);
    if (!bag || bag.length === 0) {
      bag = this.refillBag(key, pool.length);
      this.bags.set(key, bag);
    }
    const idx = bag.pop()!;
    this.lastDrawn.set(key, idx);
    return pool[idx] ?? pool[0]!;
  }

  private refillBag(key: string, size: number): number[] {
    const indices = Array.from({ length: size }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      const tmp = indices[i]!;
      indices[i] = indices[j]!;
      indices[j] = tmp;
    }

    // Popped from the end, so `indices[indices.length - 1]` is drawn first.
    // Ensure it does not immediately repeat the last drawn item from the previous bag.
    const last = this.lastDrawn.get(key);
    if (last !== undefined && indices.length > 1 && indices[indices.length - 1] === last) {
      const swapIdx = 0;
      const tmp = indices[indices.length - 1]!;
      indices[indices.length - 1] = indices[swapIdx]!;
      indices[swapIdx] = tmp;
    }

    return indices;
  }
}
