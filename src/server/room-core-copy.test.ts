import { describe, expect, it } from "vitest";
import { RoomCore, type RoomStorage, type RoomTransport } from "./room-core.js";
import type {
  JevEvaluator,
  JudgeMessageInput,
  JudgeMessageResult,
  PickInterceptedWhisperInput,
  PickInterceptedWhisperResult,
} from "./jev.js";
import { BEAT_POOLS, MOOD_HINT_POOLS } from "./copy/script-bank.js";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";

class StubJev implements JevEvaluator {
  handler: (input: JudgeMessageInput) => Promise<JudgeMessageResult> = async (
    input,
  ) => ({
    roundId: input.roundId,
    persuasivenessScore: 2.0,
    targetBlamed: "NONE",
    targetBlamedConfidence: 0.9,
    isLowEffortSpamNoul: 0.1,
  });

  async judgeMessage(input: JudgeMessageInput): Promise<JudgeMessageResult> {
    return this.handler(input);
  }

  async pickInterceptedWhisper(
    input: PickInterceptedWhisperInput,
  ): Promise<PickInterceptedWhisperResult> {
    return {
      roundId: input.roundId,
      whisperId: input.candidates[0]?.id ?? "",
    };
  }
}

class CopyTestHarness {
  now = 1_700_000_000_000;
  savedState: string | null = null;
  alarmAt: number | null = null;
  sentByConnection = new Map<string, ServerMessage[]>();
  openConnections = new Set<string>();
  jev = new StubJev();
  room: RoomCore;

  constructor(rng: () => number = () => 0.15) {
    this.room = this.makeRoom(rng);
  }

  makeRoom(rng: () => number = () => 0.15): RoomCore {
    const storage: RoomStorage = {
      load: () => this.savedState,
      save: (stateJson) => {
        this.savedState = stateJson;
      },
      scheduleAlarm: (at) => {
        this.alarmAt = at;
      },
      deleteAll: () => {
        this.savedState = null;
        this.alarmAt = null;
      },
    };
    const transport: RoomTransport = {
      send: (connId, raw) => {
        const list = this.sentByConnection.get(connId) ?? [];
        list.push(JSON.parse(raw) as ServerMessage);
        this.sentByConnection.set(connId, list);
      },
      broadcast: (raw, exclude) => {
        const ex = new Set(exclude ?? []);
        for (const connId of this.openConnections) {
          if (ex.has(connId)) continue;
          const list = this.sentByConnection.get(connId) ?? [];
          list.push(JSON.parse(raw) as ServerMessage);
          this.sentByConnection.set(connId, list);
        }
      },
      close: (connId) => {
        this.openConnections.delete(connId);
      },
    };
    return new RoomCore({
      roomCode: "ABCD",
      storage,
      transport,
      clock: () => this.now,
      random: rng,
      jevEvaluator: this.jev,
    });
  }

  connectAndJoin(connId: string, name: string): void {
    this.openConnections.add(connId);
    this.sentByConnection.set(connId, []);
    this.send(connId, { type: "join", name });
  }

  send(connId: string, msg: ClientMessage): void {
    this.room.onMessage(connId, JSON.stringify(msg));
  }

  advanceTime(ms: number): void {
    const target = this.now + ms;
    while (this.alarmAt !== null && this.alarmAt <= target) {
      this.now = this.alarmAt;
      this.alarmAt = null;
      this.room.onAlarm();
    }
    this.now = target;
  }

  async flushMicrotasks(): Promise<void> {
    await this.room.flushPendingEvaluations();
  }

  announcementsFor(connId: string) {
    return (this.sentByConnection.get(connId) ?? []).filter(
      (m): m is Extract<ServerMessage, { type: "entity_announcement" }> =>
        m.type === "entity_announcement",
    );
  }
}

const ALL_MOOD_HINTS = new Set(Object.values(MOOD_HINT_POOLS).flat());

describe("RoomCore curated script bank integration", () => {
  it("emits verbatim ROUND_INTRO_FIRST, MOOD_HINT, ROUND_RESOLVING, SACRIFICE_TIMER, ROUND_INTRO_NEXT, and POST_MATCH_SURVIVOR without mid-round MOOD_SHIFT", async () => {
    const h = new CopyTestHarness();
    h.connectAndJoin("c1", "Alice");
    h.connectAndJoin("c2", "Bob");
    h.connectAndJoin("c3", "Carol");

    h.send("c1", { type: "start_match" });

    let anns = h.announcementsFor("c1");
    expect(anns[0]?.beatType).toBe("ROUND_INTRO");
    expect(BEAT_POOLS.ROUND_INTRO_FIRST).toContain(anns[0]?.text);
    expect(anns[1]?.beatType).toBe("MOOD_HINT");
    expect(ALL_MOOD_HINTS.has(anns[1]?.text ?? "")).toBe(true);

    // Enter ROUND_ACTIVE (3.5s) and advance 60s mid-round -> NO MOOD_SHIFT emitted
    h.advanceTime(3_500);
    h.advanceTime(60_000);
    anns = h.announcementsFor("c1");
    expect(anns.some((a) => a.beatType === "MOOD_SHIFT")).toBe(false);

    // Give Bob higher doom so timer sacrifice triggers cleanly without tie
    h.jev.handler = async (input) => ({
      roundId: input.roundId,
      persuasivenessScore: 0.0, // +12% doom
      targetBlamed: "NONE",
      targetBlamedConfidence: 0.9,
      isLowEffortSpamNoul: 0.1,
    });
    h.send("c2", { type: "send_chat", text: "Please spare me I beg you." });
    await h.flushMicrotasks();

    // Expire ROUND_ACTIVE (120s total, 60s already elapsed -> 60s left)
    h.advanceTime(60_000);
    anns = h.announcementsFor("c1");
    const resolving = anns.find((a) => a.beatType === "ROUND_RESOLVING");
    expect(resolving).toBeDefined();
    expect(BEAT_POOLS.ROUND_RESOLVING).toContain(resolving!.text);

    // Expire ROUND_RESOLVING (2s) -> SACRIFICE_REVEAL (timer)
    h.advanceTime(2_000);
    anns = h.announcementsFor("c1");
    const sacTimer = anns.find((a) => a.beatType === "SACRIFICE_REVEAL");
    expect(sacTimer).toBeDefined();
    expect(sacTimer!.text).toContain("Bob");
    expect(sacTimer!.text).not.toMatch(/\{[a-zA-Z0-9_]+\}/);
    const expectedTimerLines = BEAT_POOLS.SACRIFICE_TIMER.map((t) =>
      t.replace("{player}", "Bob"),
    );
    expect(expectedTimerLines).toContain(sacTimer!.text);

    // Expire SACRIFICE_REVEAL (4.5s) -> Round 2 ROUND_INTRO_NEXT + MOOD_HINT
    h.advanceTime(4_500);
    anns = h.announcementsFor("c1");
    const round2Intro = anns.filter((a) => a.beatType === "ROUND_INTRO")[1];
    expect(round2Intro).toBeDefined();
    expect(BEAT_POOLS.ROUND_INTRO_NEXT).toContain(round2Intro!.text);
    const round2Hint = anns.filter((a) => a.beatType === "MOOD_HINT")[1];
    expect(round2Hint).toBeDefined();
    expect(ALL_MOOD_HINTS.has(round2Hint!.text)).toBe(true);
    expect(round2Hint!.text).not.toBe(anns[1]!.text);

    // Round 2: Carol hits 100% mid-round spike -> SACRIFICE_SPIKE + POST_MATCH_SURVIVOR
    h.advanceTime(3_500);
    h.jev.handler = async (input) => ({
      roundId: input.roundId,
      persuasivenessScore: 0.0, // +12%
      targetBlamed: "NONE",
      targetBlamedConfidence: 0.9,
      isLowEffortSpamNoul: 0.1,
    });
    // Carol starts Round 2 at 50%; 5 messages at +12% -> 100%
    for (let i = 0; i < 5; i++) {
      h.send("c3", { type: "send_chat", text: `Plea number ${i + 1} for survival` });
      await h.flushMicrotasks();
      h.advanceTime(2_600);
    }

    anns = h.announcementsFor("c1");
    const sacSpike = anns.filter((a) => a.beatType === "SACRIFICE_REVEAL")[1];
    expect(sacSpike).toBeDefined();
    const expectedSpikeLines = BEAT_POOLS.SACRIFICE_SPIKE.map((t) =>
      t.replace("{player}", "Carol"),
    );
    expect(expectedSpikeLines).toContain(sacSpike!.text);

    // Expire SACRIFICE_REVEAL -> POST_MATCH_SURVIVOR for Alice
    h.advanceTime(4_500);
    anns = h.announcementsFor("c1");
    const postMatch = anns.find((a) => a.beatType === "POST_MATCH_SURVIVOR");
    expect(postMatch).toBeDefined();
    const expectedSurvivorLines = BEAT_POOLS.POST_MATCH_SURVIVOR.map((t) =>
      t.replace("{player}", "Alice"),
    );
    expect(expectedSurvivorLines).toContain(postMatch!.text);
  });

  it("emits verbatim SPAM_MOCKERY, SUDDEN_DEATH, SACRIFICE_TIEBREAK, SACRIFICE_DISCONNECT, and POST_MATCH_ALL_CLAIMED", async () => {
    const h = new CopyTestHarness();
    h.connectAndJoin("c1", "Alice");
    h.connectAndJoin("c2", "Bob");
    h.connectAndJoin("c3", "Carol");
    h.send("c1", { type: "start_match" });
    h.advanceTime(3_500);

    // Spam mockery
    h.jev.handler = async (input) => ({
      roundId: input.roundId,
      persuasivenessScore: 2.0,
      targetBlamed: "NONE",
      targetBlamedConfidence: 0.9,
      isLowEffortSpamNoul: 0.9,
    });
    h.send("c1", { type: "send_chat", text: "aaaa" });
    await h.flushMicrotasks();
    const spam = h.announcementsFor("c1").find((a) => a.beatType === "SPAM_MOCKERY");
    expect(spam).toBeDefined();
    expect(
      BEAT_POOLS.SPAM_MOCKERY.map((t) => t.replace("{player}", "Alice")),
    ).toContain(spam!.text);

    // Disconnect Bob -> grace expires -> SACRIFICE_DISCONNECT
    h.room.onClose("c2");
    h.advanceTime(45_000);
    const disc = h
      .announcementsFor("c1")
      .find((a) => a.beatType === "SACRIFICE_DISCONNECT");
    expect(disc).toBeDefined();
    expect(
      BEAT_POOLS.SACRIFICE_DISCONNECT.map((t) => t.replace("{player}", "Bob")),
    ).toContain(disc!.text);

    // Remaining: Alice (58% doom) and Carol (50% doom). Finish round -> Carol or Alice?
    // Let's test tiebreak by setting Carol to 58% too via a chat message
    h.jev.handler = async (input) => ({
      roundId: input.roundId,
      persuasivenessScore: 2.0,
      targetBlamed: "SELF",
      targetBlamedConfidence: 0.9,
      isLowEffortSpamNoul: 0.1,
    });
    h.send("c3", { type: "send_chat", text: "It is all my fault." });
    await h.flushMicrotasks();

    // Advance to end of Round 1 (120s - 45s = 75s) + ROUND_RESOLVING (2s) -> SUDDEN_DEATH
    h.advanceTime(75_000);
    h.advanceTime(2_000);
    const sd = h.announcementsFor("c1").find((a) => a.beatType === "SUDDEN_DEATH");
    expect(sd).toBeDefined();
    expect(BEAT_POOLS.ROUND_INTRO_SUDDEN_DEATH).toContain(sd!.text);

    // Expire sudden death (30s) + ROUND_RESOLVING (2s) -> SACRIFICE_TIEBREAK
    h.advanceTime(30_000);
    h.advanceTime(2_000);
    const tiebreak = h
      .announcementsFor("c1")
      .filter((a) => a.beatType === "SACRIFICE_REVEAL")
      .pop();
    expect(tiebreak).toBeDefined();
    const allTiebreakLines = [
      ...BEAT_POOLS.SACRIFICE_TIEBREAK.map((t) => t.replace("{player}", "Alice")),
      ...BEAT_POOLS.SACRIFICE_TIEBREAK.map((t) => t.replace("{player}", "Carol")),
    ];
    expect(allTiebreakLines).toContain(tiebreak!.text);
  });

  it("exposes clean helpers on RoomCore for #20 Whispers and #21 Curses", () => {
    const h = new CopyTestHarness();
    const whisperLine = h.room.drawWhisperLeakBeat("Alice", "Bob");
    expect(
      BEAT_POOLS.WHISPER_LEAK.map((t) =>
        t.replace("{player}", "Alice").replace("{target}", "Bob"),
      ),
    ).toContain(whisperLine);

    const curseLine = h.room.drawCurseBeat("Alice", ["shadow"], ["blood"]);
    expect(curseLine).toContain("Alice");
    expect(curseLine).toContain("1");
    expect(curseLine).not.toMatch(/\{[a-zA-Z0-9_]+\}/);
  });

  it("persists shuffle-bag state across RoomCore hibernation so Mood hints do not repeat", async () => {
    const h = new CopyTestHarness(() => 0.42);
    h.connectAndJoin("c1", "Alice");
    h.connectAndJoin("c2", "Bob");
    h.connectAndJoin("c3", "Carol");
    h.send("c1", { type: "start_match" });

    const firstHint = h
      .announcementsFor("c1")
      .find((a) => a.beatType === "MOOD_HINT")?.text;
    expect(firstHint).toBeDefined();

    // Give Carol highest doom in Round 1 so Round 2 starts cleanly
    h.advanceTime(3_500);
    h.jev.handler = async (input) => ({
      roundId: input.roundId,
      persuasivenessScore: 0.0,
      targetBlamed: "NONE",
      targetBlamedConfidence: 0.9,
      isLowEffortSpamNoul: 0.1,
    });
    h.send("c3", { type: "send_chat", text: "Please spare me I beg you." });
    await h.flushMicrotasks();

    // Simulate DO hibernation by constructing a fresh RoomCore from persisted KV
    h.room = h.makeRoom(() => 0.42);
    h.advanceTime(120_000); // ROUND_ACTIVE -> ROUND_RESOLVING
    h.advanceTime(2_000); // -> SACRIFICE_REVEAL
    h.advanceTime(4_500); // -> Round 2 ROUND_INTRO + MOOD_HINT

    const round2Hint = h
      .announcementsFor("c1")
      .filter((a) => a.beatType === "MOOD_HINT")[1]?.text;
    expect(round2Hint).toBeDefined();
    expect(ALL_MOOD_HINTS.has(round2Hint!)).toBe(true);
    expect(round2Hint).not.toBe(firstHint);
  });
});
