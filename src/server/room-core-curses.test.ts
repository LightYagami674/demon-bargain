import { describe, it, expect } from "vitest";
import { RoomCore, type RoomStorage, type RoomTransport } from "./room-core.js";
import type {
  JevEvaluator,
  JudgeMessageInput,
  JudgeMessageResult,
  PickInterceptedWhisperInput,
  PickInterceptedWhisperResult,
} from "./jev.js";
import {
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "../shared/protocol.js";

class FakeJevEvaluator implements JevEvaluator {
  judgeCalls: JudgeMessageInput[] = [];
  private nextHandler: (
    input: JudgeMessageInput,
  ) => Promise<JudgeMessageResult> = async (input) => ({
    roundId: input.roundId,
    persuasivenessScore: 2.0,
    targetBlamed: "NONE",
    targetBlamedConfidence: 0.9,
    isLowEffortSpamNoul: 0.1,
  });

  onJudge(
    handler: (input: JudgeMessageInput) => Promise<JudgeMessageResult>,
  ): void {
    this.nextHandler = handler;
  }

  async judgeMessage(input: JudgeMessageInput): Promise<JudgeMessageResult> {
    this.judgeCalls.push(input);
    return this.nextHandler(input);
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

class FakeCurseRoomHarness {
  now = 1_700_000_000_000;
  alarmAt: number | null = null;
  storedState: string | null = null;
  closedConnections = new Set<string>();
  sentByConnection = new Map<string, ServerMessage[]>();
  private idCounter = 0;
  readonly jev = new FakeJevEvaluator();
  readonly room: RoomCore;

  constructor() {
    const transport: RoomTransport = {
      send: (connectionId, payload) => {
        if (this.closedConnections.has(connectionId)) return;
        const parsed = ServerMessageSchema.parse(JSON.parse(payload));
        const list = this.sentByConnection.get(connectionId) ?? [];
        list.push(parsed);
        this.sentByConnection.set(connectionId, list);
      },
      broadcast: (payload, excludeConnectionIds = []) => {
        const excluded = new Set(excludeConnectionIds);
        const parsed = ServerMessageSchema.parse(JSON.parse(payload));
        for (const connId of this.sentByConnection.keys()) {
          if (this.closedConnections.has(connId) || excluded.has(connId)) {
            continue;
          }
          const list = this.sentByConnection.get(connId) ?? [];
          list.push(parsed);
          this.sentByConnection.set(connId, list);
        }
      },
      close: (connectionId) => {
        this.closedConnections.add(connectionId);
      },
    };

    const storage: RoomStorage = {
      load: () => this.storedState,
      save: (json) => {
        this.storedState = json;
      },
      scheduleAlarm: (at) => {
        this.alarmAt = at;
      },
      deleteAll: () => {
        this.storedState = null;
      },
    };

    this.room = new RoomCore({
      roomCode: "ABCD",
      transport,
      storage,
      clock: () => this.now,
      generateId: () => `id-${++this.idCounter}`,
      random: () => 0.1,
      jevEvaluator: this.jev,
    });
  }

  connect(connectionId: string): void {
    this.closedConnections.delete(connectionId);
    if (!this.sentByConnection.has(connectionId)) {
      this.sentByConnection.set(connectionId, []);
    }
  }

  send(connectionId: string, msg: ClientMessage): void {
    this.room.onMessage(connectionId, JSON.stringify(msg));
  }

  advanceTime(ms: number): void {
    this.now += ms;
    if (this.alarmAt !== null && this.now >= this.alarmAt) {
      this.alarmAt = null;
      this.room.onAlarm();
    }
  }

  messagesFor(connectionId: string): ServerMessage[] {
    return this.sentByConnection.get(connectionId) ?? [];
  }

  clearMessages(): void {
    for (const key of this.sentByConnection.keys()) {
      this.sentByConnection.set(key, []);
    }
  }

  async flushMicrotasks(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function setupMatchWithGhost() {
  const h = new FakeCurseRoomHarness();
  h.connect("c1");
  h.send("c1", { type: "join", name: "Alice" });
  h.connect("c2");
  h.send("c2", { type: "join", name: "Bob" });
  h.connect("c3");
  h.send("c3", { type: "join", name: "Cara" });

  const s1 = h.messagesFor("c1").find((m) => m.type === "room_snapshot")!;
  const s2 = h.messagesFor("c2").find((m) => m.type === "room_snapshot")!;
  const s3 = h.messagesFor("c3").find((m) => m.type === "room_snapshot")!;

  h.send("c1", { type: "start_match" });
  h.advanceTime(3_500); // ROUND_INTRO -> ROUND_ACTIVE

  // Spike Alice to 100% Doom so she becomes a Ghost in Round 2
  h.jev.onJudge(async (input) => ({
    roundId: input.roundId,
    persuasivenessScore: 0.0,
    targetBlamed: "SELF",
    targetBlamedConfidence: 0.9,
    isLowEffortSpamNoul: 0.1,
  }));

  for (let i = 0; i < 3; i++) {
    h.send("c1", { type: "send_chat", text: `Please spare me ${i}` });
    await h.flushMicrotasks();
    h.advanceTime(2_600);
  }

  // Alice is now in SACRIFICE_REVEAL -> advance to Round 2 ROUND_ACTIVE
  h.advanceTime(4_500);
  h.advanceTime(3_500);

  // Reset Jev to neutral
  h.jev.onJudge(async (input) => ({
    roundId: input.roundId,
    persuasivenessScore: 2.0,
    targetBlamed: "NONE",
    targetBlamedConfidence: 0.9,
    isLowEffortSpamNoul: 0.1,
  }));
  h.jev.judgeCalls = [];
  h.clearMessages();

  return {
    h,
    alice: { conn: "c1", id: s1.selfPlayerId, token: s1.playerToken },
    bob: { conn: "c2", id: s2.selfPlayerId, token: s2.playerToken },
    cara: { conn: "c3", id: s3.selfPlayerId, token: s3.playerToken },
  };
}

describe("RoomCore Seam — Ghost Curses", () => {
  it("scopes curse_applied and room_snapshot.activeCurses strictly to target and Ghosts, and enforces validation, cooldown, and deduplication", async () => {
    const { h, alice, bob, cara } = await setupMatchWithGhost();

    // Living player cannot cast a Curse
    h.send(bob.conn, {
      type: "cast_curse",
      targetPlayerId: cara.id,
      word: "blood",
    });
    expect(h.messagesFor(bob.conn).at(-1)).toMatchObject({
      type: "error",
      code: "INVALID_PAYLOAD",
    });

    // Invalid Curse words are rejected with INVALID_CURSE_WORD
    for (const bad of ["a", "two words", "123", "--bad", "a".repeat(21)]) {
      h.clearMessages();
      h.send(alice.conn, {
        type: "cast_curse",
        targetPlayerId: bob.id,
        word: bad,
      });
      expect(h.messagesFor(alice.conn).at(-1)).toMatchObject({
        type: "error",
        code: "INVALID_CURSE_WORD",
      });
    }

    // Valid Curse cast by Ghost Alice onto living Bob
    h.clearMessages();
    h.send(alice.conn, {
      type: "cast_curse",
      targetPlayerId: bob.id,
      word: "blood",
    });

    const aliceCurseMsg = h
      .messagesFor(alice.conn)
      .find((m) => m.type === "curse_applied");
    const bobCurseMsg = h
      .messagesFor(bob.conn)
      .find((m) => m.type === "curse_applied");
    const caraCurseMsg = h
      .messagesFor(cara.conn)
      .find((m) => m.type === "curse_applied");

    expect(aliceCurseMsg).toMatchObject({
      type: "curse_applied",
      curse: {
        ghostPlayerId: alice.id,
        targetPlayerId: bob.id,
        word: "blood",
      },
    });
    expect(bobCurseMsg).toEqual(aliceCurseMsg);
    expect(caraCurseMsg).toBeUndefined();

    // Privacy invariant on reconnect snapshots
    h.clearMessages();
    h.send(cara.conn, { type: "join", playerToken: cara.token });
    const caraSnap = h
      .messagesFor(cara.conn)
      .find((m) => m.type === "room_snapshot");
    expect(caraSnap?.type === "room_snapshot" && caraSnap.activeCurses).toEqual(
      [],
    );

    h.send(bob.conn, { type: "join", playerToken: bob.token });
    const bobSnap = h
      .messagesFor(bob.conn)
      .find((m) => m.type === "room_snapshot");
    expect(
      bobSnap?.type === "room_snapshot" && bobSnap.activeCurses,
    ).toHaveLength(1);

    h.send(alice.conn, { type: "join", playerToken: alice.token });
    const aliceSnap = h
      .messagesFor(alice.conn)
      .find((m) => m.type === "room_snapshot");
    expect(
      aliceSnap?.type === "room_snapshot" && aliceSnap.activeCurses,
    ).toHaveLength(1);
    expect(
      aliceSnap?.type === "room_snapshot" && aliceSnap.curseCooldownEndsAt,
    ).toBeGreaterThan(h.now);

    // 15s cooldown enforced
    h.clearMessages();
    h.send(alice.conn, {
      type: "cast_curse",
      targetPlayerId: cara.id,
      word: "shadow",
    });
    expect(h.messagesFor(alice.conn).at(-1)).toMatchObject({
      type: "error",
      code: "COOLDOWN_ACTIVE",
    });

    // After 15s cooldown, duplicate case-insensitive word on same target is rejected
    h.advanceTime(15_000);
    h.clearMessages();
    h.send(alice.conn, {
      type: "cast_curse",
      targetPlayerId: bob.id,
      word: "BLOOD",
    });
    expect(h.messagesFor(alice.conn).at(-1)).toMatchObject({
      type: "error",
      code: "DUPLICATE_CURSE",
    });

    // Distinct word with apostrophe/hyphen stacks onto Bob
    h.clearMessages();
    h.send(alice.conn, {
      type: "cast_curse",
      targetPlayerId: bob.id,
      word: "blood-pact",
    });
    expect(
      h.messagesFor(bob.conn).find((m) => m.type === "curse_applied"),
    ).toMatchObject({
      type: "curse_applied",
      curse: { targetPlayerId: bob.id, word: "blood-pact" },
    });
  });

  it("evaluates active Curses via word-boundary pre-check + batched Jev naturalness, collapses callout, and scopes curse_resolved", async () => {
    const { h, alice, bob, cara } = await setupMatchWithGhost();
    const bobInitialDoom =
      h
        .messagesFor(bob.conn)
        .find((m) => m.type === "phase_changed")
        ?.type === "phase_changed"
        ? 0
        : 0;
    void bobInitialDoom;

    // Stack 3 curses onto Bob
    h.send(alice.conn, {
      type: "cast_curse",
      targetPlayerId: bob.id,
      word: "blood",
    });
    h.advanceTime(15_000);
    h.send(alice.conn, {
      type: "cast_curse",
      targetPlayerId: bob.id,
      word: "shadow",
    });
    h.advanceTime(15_000);
    h.send(alice.conn, {
      type: "cast_curse",
      targetPlayerId: bob.id,
      word: "mercy",
    });

    // Whisper does not evaluate or clear Curses
    h.send(bob.conn, {
      type: "send_whisper",
      targetPlayerId: cara.id,
      text: "blood shadow mercy",
    });
    expect(h.jev.judgeCalls).toHaveLength(0);

    // Reconnect Bob to get his current doom
    h.clearMessages();
    h.send(bob.conn, { type: "join", playerToken: bob.token });
    const snap = h
      .messagesFor(bob.conn)
      .find((m) => m.type === "room_snapshot")!;
    expect(snap.type === "room_snapshot" && snap.activeCurses).toHaveLength(3);
    const bobDoomBefore =
      snap.type === "room_snapshot"
        ? snap.players.find((p) => p.id === bob.id)!.doom
        : 50;

    h.jev.onJudge(async (input) => ({
      roundId: input.roundId,
      persuasivenessScore: 2.0,
      targetBlamed: "NONE",
      targetBlamedConfidence: 0.9,
      isLowEffortSpamNoul: 0.1,
      curseResults: {
        blood: true,
        shadow: false,
      },
    }));

    h.clearMessages();
    // "merciful" must NOT satisfy word-boundary for "mercy"
    h.send(bob.conn, {
      type: "send_chat",
      text: "My blood runs cold in this shadow, be merciful!",
    });
    await h.flushMicrotasks();

    // Only word-boundary passing words ("blood", "shadow") are batched into Jev
    expect(h.jev.judgeCalls).toHaveLength(1);
    expect(h.jev.judgeCalls[0]!.activeCurses).toEqual(["blood", "shadow"]);

    // Bob gets +24% Doom (+12% for missing "mercy", +12% for unnatural "shadow")
    const doomMsg = h
      .messagesFor(bob.conn)
      .find((m) => m.type === "doom_updated");
    expect(doomMsg).toMatchObject({
      type: "doom_updated",
      updates: [
        {
          playerId: bob.id,
          doom: Math.min(100, bobDoomBefore + 24),
        },
      ],
    });

    // curse_resolved is scoped to Bob and Ghost Alice only (not Cara)
    const bobResolved = h
      .messagesFor(bob.conn)
      .find((m) => m.type === "curse_resolved");
    const aliceResolved = h
      .messagesFor(alice.conn)
      .find((m) => m.type === "curse_resolved");
    const caraResolved = h
      .messagesFor(cara.conn)
      .find((m) => m.type === "curse_resolved");
    expect(bobResolved).toMatchObject({
      type: "curse_resolved",
      targetPlayerId: bob.id,
      results: [
        { word: "blood", passed: true, reason: "NATURAL" },
        { word: "shadow", passed: false, reason: "UNNATURAL" },
        { word: "mercy", passed: false, reason: "MISSING_WORD" },
      ],
    });
    expect(aliceResolved).toEqual(bobResolved);
    expect(caraResolved).toBeUndefined();

    // Collapsed single public Entity callout (CURSE_MIXED)
    const entityMsgs = h
      .messagesFor(cara.conn)
      .filter((m) => m.type === "entity_announcement");
    expect(entityMsgs).toHaveLength(1);
    expect(entityMsgs[0]).toMatchObject({
      type: "entity_announcement",
      beatType: "CURSE_MIXED",
    });

    // Evaluated Curses are cleared
    h.clearMessages();
    h.send(bob.conn, { type: "join", playerToken: bob.token });
    const afterSnap = h
      .messagesFor(bob.conn)
      .find((m) => m.type === "room_snapshot")!;
    expect(
      afterSnap.type === "room_snapshot" && afterSnap.activeCurses,
    ).toEqual([]);
  });

  it("auto-fails all active Curses when Jev flags the public message as spam", async () => {
    const { h, alice, bob } = await setupMatchWithGhost();

    h.send(alice.conn, {
      type: "cast_curse",
      targetPlayerId: bob.id,
      word: "blood",
    });
    h.advanceTime(15_000);
    h.send(alice.conn, {
      type: "cast_curse",
      targetPlayerId: bob.id,
      word: "shadow",
    });

    h.clearMessages();
    h.send(bob.conn, { type: "join", playerToken: bob.token });
    const snap = h
      .messagesFor(bob.conn)
      .find((m) => m.type === "room_snapshot")!;
    const bobDoomBefore =
      snap.type === "room_snapshot"
        ? snap.players.find((p) => p.id === bob.id)!.doom
        : 50;

    h.jev.onJudge(async (input) => ({
      roundId: input.roundId,
      persuasivenessScore: 3.5,
      targetBlamed: "NONE",
      targetBlamedConfidence: 0.9,
      isLowEffortSpamNoul: 0.85,
      curseResults: {
        blood: true,
        shadow: true,
      },
    }));

    h.clearMessages();
    h.send(bob.conn, {
      type: "send_chat",
      text: "blood shadow blood shadow",
    });
    await h.flushMicrotasks();

    // +8% spam + 2 * 12% failed curses = +32%
    const doomMsg = h
      .messagesFor(bob.conn)
      .find((m) => m.type === "doom_updated");
    expect(doomMsg).toMatchObject({
      type: "doom_updated",
      updates: [
        {
          playerId: bob.id,
          doom: Math.min(100, bobDoomBefore + 32),
        },
      ],
    });

    const resolved = h
      .messagesFor(bob.conn)
      .find((m) => m.type === "curse_resolved");
    expect(resolved).toMatchObject({
      type: "curse_resolved",
      results: [
        { word: "blood", passed: false, reason: "SPAM" },
        { word: "shadow", passed: false, reason: "SPAM" },
      ],
    });

    const curseBeat = h
      .messagesFor(bob.conn)
      .find(
        (m) => m.type === "entity_announcement" && m.beatType === "CURSE_FAIL",
      );
    expect(curseBeat).toBeDefined();
  });

  it("clears unevaluated Curses harmlessly at round end and resets Ghost cooldown for the next round", async () => {
    const h = new FakeCurseRoomHarness();
    h.connect("c1");
    h.send("c1", { type: "join", name: "Alice" });
    h.connect("c2");
    h.send("c2", { type: "join", name: "Bob" });
    h.connect("c3");
    h.send("c3", { type: "join", name: "Cara" });
    h.connect("c4");
    h.send("c4", { type: "join", name: "Dan" });

    const s1 = h.messagesFor("c1").find((m) => m.type === "room_snapshot")!;
    const s2 = h.messagesFor("c2").find((m) => m.type === "room_snapshot")!;
    const s3 = h.messagesFor("c3").find((m) => m.type === "room_snapshot")!;

    h.send("c1", { type: "start_match" });
    h.advanceTime(3_500); // Round 1 ROUND_ACTIVE

    // Spike Alice to 100% -> Ghost
    h.jev.onJudge(async (input) => ({
      roundId: input.roundId,
      persuasivenessScore: 0.0,
      targetBlamed: "SELF",
      targetBlamedConfidence: 0.9,
      isLowEffortSpamNoul: 0.1,
    }));
    for (let i = 0; i < 3; i++) {
      h.send("c1", { type: "send_chat", text: `End me ${i}` });
      await h.flushMicrotasks();
      h.advanceTime(2_600);
    }

    // Advance into Round 2 ROUND_ACTIVE (Bob, Cara, Dan alive; Alice Ghost)
    h.advanceTime(4_500);
    h.advanceTime(3_500);

    // Ghost Alice curses Cara, then Bob gets sacrificed mid-round without Cara speaking
    h.send("c1", {
      type: "cast_curse",
      targetPlayerId: s3.selfPlayerId,
      word: "candle",
    });
    for (let i = 0; i < 3; i++) {
      h.send("c2", { type: "send_chat", text: `End Bob ${i}` });
      await h.flushMicrotasks();
      h.advanceTime(2_600);
    }

    // Advance into Round 3 ROUND_ACTIVE (only ~8s elapsed, less than 15s cooldown!)
    h.advanceTime(4_500);
    h.advanceTime(3_500);

    // Cara's unevaluated Curse was cleared harmlessly
    h.clearMessages();
    h.send("c1", { type: "join", playerToken: s1.playerToken });
    const aliceSnap = h
      .messagesFor("c1")
      .find((m) => m.type === "room_snapshot")!;
    expect(
      aliceSnap.type === "room_snapshot" && aliceSnap.activeCurses,
    ).toEqual([]);
    expect(
      aliceSnap.type === "room_snapshot" && aliceSnap.curseCooldownEndsAt,
    ).toBeNull();

    // Ghost Alice can cast immediately in Round 3 (cooldown reset!)
    h.clearMessages();
    h.send("c1", {
      type: "cast_curse",
      targetPlayerId: s3.selfPlayerId,
      word: "hollow",
    });
    expect(
      h.messagesFor("c1").find((m) => m.type === "curse_applied"),
    ).toMatchObject({
      type: "curse_applied",
      curse: { targetPlayerId: s3.selfPlayerId, word: "hollow" },
    });
  });
});
