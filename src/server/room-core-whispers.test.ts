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
import {
  ROUND_INTRO_MS,
  WHISPER_COOLDOWN_MS,
} from "../shared/constants.js";

class FakeJevEvaluator implements JevEvaluator {
  judgeCalls: JudgeMessageInput[] = [];
  whisperCalls: PickInterceptedWhisperInput[] = [];
  private whisperHandler: (
    input: PickInterceptedWhisperInput,
  ) => Promise<PickInterceptedWhisperResult> = async (input) => ({
    roundId: input.roundId,
    whisperId: input.candidates[0]?.id ?? "",
  });

  onPickWhisper(
    handler: (
      input: PickInterceptedWhisperInput,
    ) => Promise<PickInterceptedWhisperResult>,
  ): void {
    this.whisperHandler = handler;
  }

  async judgeMessage(input: JudgeMessageInput): Promise<JudgeMessageResult> {
    this.judgeCalls.push(input);
    return {
      roundId: input.roundId,
      persuasivenessScore: 2.0,
      targetBlamed: "NONE",
      targetBlamedConfidence: 0.9,
      isLowEffortSpamNoul: 0.1,
    };
  }

  async pickInterceptedWhisper(
    input: PickInterceptedWhisperInput,
  ): Promise<PickInterceptedWhisperResult> {
    this.whisperCalls.push(input);
    return this.whisperHandler(input);
  }
}

class FakeWhisperRoomHarness {
  now = 1_700_000_000_000;
  alarmAt: number | null = null;
  storedState: string | null = null;
  closedConnections = new Set<string>();
  sentByConnection = new Map<string, ServerMessage[]>();
  private idCounter = 0;
  readonly jev = new FakeJevEvaluator();
  readonly room: RoomCore;

  constructor(randomValues: number[] = [0.1, 0.4, 0.7, 0.2, 0.9]) {
    let rngIdx = 0;
    const random = () => {
      const val = randomValues[rngIdx % randomValues.length] ?? 0.5;
      rngIdx += 1;
      return val;
    };

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
          if (excluded.has(connId) || this.closedConnections.has(connId)) {
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
      save: (stateJson) => {
        this.storedState = stateJson;
      },
      scheduleAlarm: (at) => {
        this.alarmAt = at;
      },
      deleteAll: () => {
        this.storedState = null;
        this.alarmAt = null;
      },
    };

    this.room = new RoomCore({
      roomCode: "ABCD",
      transport,
      storage,
      clock: () => this.now,
      generateId: () => `id-${++this.idCounter}`,
      random,
      jevEvaluator: this.jev,
    });
  }

  connectAndJoin(connId: string, name: string): {
    playerId: string;
    playerToken: string;
  } {
    this.sentByConnection.set(connId, []);
    this.closedConnections.delete(connId);
    this.send(connId, { type: "join", name });
    const snap = this.sent(connId).find((m) => m.type === "room_snapshot");
    if (!snap || snap.type !== "room_snapshot") {
      throw new Error(`No snapshot received for ${connId}`);
    }
    return { playerId: snap.selfPlayerId, playerToken: snap.playerToken };
  }

  reconnect(connId: string, playerToken: string) {
    this.sentByConnection.set(connId, []);
    this.closedConnections.delete(connId);
    this.send(connId, { type: "join", playerToken });
    const snap = this.sent(connId).find((m) => m.type === "room_snapshot");
    if (!snap || snap.type !== "room_snapshot") {
      throw new Error(`No snapshot received on reconnect for ${connId}`);
    }
    return snap;
  }

  send(connId: string, msg: ClientMessage): void {
    this.room.onMessage(connId, JSON.stringify(msg));
  }

  sent(connId: string): ServerMessage[] {
    return this.sentByConnection.get(connId) ?? [];
  }

  advanceTime(ms: number): void {
    this.now += ms;
    if (this.alarmAt !== null && this.now >= this.alarmAt) {
      this.room.onAlarm();
    }
  }
}

function setupThreePlayerActiveRound() {
  const h = new FakeWhisperRoomHarness();
  const alice = h.connectAndJoin("c1", "Alice");
  const bob = h.connectAndJoin("c2", "Bob");
  const cara = h.connectAndJoin("c3", "Cara");
  h.send("c1", { type: "start_match" });
  h.advanceTime(ROUND_INTRO_MS);
  return { h, alice, bob, cara };
}

describe("RoomCore Seam — Secret Whispers & Privacy Isolation", () => {
  it("delivers un-leaked whispers strictly to sender and recipient, and enforces snapshot privacy on reconnect", () => {
    const { h, alice, bob, cara } = setupThreePlayerActiveRound();

    h.send("c1", {
      type: "send_whisper",
      targetPlayerId: bob.playerId,
      text: "Let us vote out Cara",
    });

    const aliceWhispers = h
      .sent("c1")
      .filter((m) => m.type === "whisper_message");
    const bobWhispers = h
      .sent("c2")
      .filter((m) => m.type === "whisper_message");
    const caraWhispers = h
      .sent("c3")
      .filter((m) => m.type === "whisper_message");

    expect(aliceWhispers).toHaveLength(1);
    expect(bobWhispers).toHaveLength(1);
    expect(caraWhispers).toHaveLength(0);

    // Reconnect all three and verify room_snapshot feed privacy
    const aliceSnap = h.reconnect("c1-re", alice.playerToken);
    const bobSnap = h.reconnect("c2-re", bob.playerToken);
    const caraSnap = h.reconnect("c3-re", cara.playerToken);

    expect(aliceSnap.feed?.some((f) => f.kind === "whisper")).toBe(true);
    expect(bobSnap.feed?.some((f) => f.kind === "whisper")).toBe(true);
    expect(caraSnap.feed?.some((f) => f.kind === "whisper")).toBe(false);
  });

  it("disables whispers when <= 2 living players remain and rejects Ghost senders/targets", () => {
    // 2-player match
    const h2 = new FakeWhisperRoomHarness();
    const a2 = h2.connectAndJoin("c1", "Alice");
    const b2 = h2.connectAndJoin("c2", "Bob");
    h2.send("c1", { type: "start_match" });
    h2.advanceTime(ROUND_INTRO_MS);

    h2.send("c1", {
      type: "send_whisper",
      targetPlayerId: b2.playerId,
      text: "Secret",
    });
    const err2 = h2.sent("c1").find((m) => m.type === "error");
    expect(err2?.type === "error" && err2.code).toBe("INVALID_PAYLOAD");
    expect(a2.playerId).toBeTruthy();

    // 3-player match where Cara is a Ghost -> 2 living remain -> disabled
    const { h, bob, cara } = setupThreePlayerActiveRound();
    h.room.setPlayerDoomForMatch(cara.playerId, 100);
    // Simulate Cara eliminated via ROUND_RESOLVING -> SACRIFICE_REVEAL -> Round 2
    h.advanceTime(55_000); // ROUND_ACTIVE -> ROUND_RESOLVING
    h.advanceTime(2_500); // ROUND_RESOLVING -> SACRIFICE_REVEAL
    h.advanceTime(4_500); // SACRIFICE_REVEAL -> Round 2 ROUND_INTRO
    h.advanceTime(ROUND_INTRO_MS); // ROUND_INTRO -> ROUND_ACTIVE (2 living: Alice, Bob)

    h.send("c1", {
      type: "send_whisper",
      targetPlayerId: bob.playerId,
      text: "Still secret?",
    });
    const errAfterSac = h
      .sent("c1")
      .filter((m) => m.type === "error")
      .pop();
    expect(errAfterSac?.type === "error" && errAfterSac.code).toBe(
      "INVALID_PAYLOAD",
    );

    // Ghost Cara also cannot whisper
    h.send("c3", {
      type: "send_whisper",
      targetPlayerId: bob.playerId,
      text: "Boo",
    });
    const ghostErr = h.sent("c3").find((m) => m.type === "error");
    expect(ghostErr?.type === "error" && ghostErr.code).toBe("INVALID_PAYLOAD");
  });

  it("enforces 1-160 char limit and independent 2.5s cooldown without colliding with send_chat", () => {
    const { h, bob } = setupThreePlayerActiveRound();

    // Empty / whitespace rejected
    h.send("c1", {
      type: "send_whisper",
      targetPlayerId: bob.playerId,
      text: "   ",
    });
    expect(h.sent("c1").pop()?.type).toBe("error");

    // 161 chars rejected
    h.send("c1", {
      type: "send_whisper",
      targetPlayerId: bob.playerId,
      text: "a".repeat(161),
    });
    expect(h.sent("c1").pop()?.type).toBe("error");

    // 1 char allowed, and public chat immediately after is NOT blocked
    h.send("c1", {
      type: "send_whisper",
      targetPlayerId: bob.playerId,
      text: "x",
    });
    expect(h.sent("c1").pop()?.type).toBe("whisper_message");

    h.send("c1", { type: "send_chat", text: "Public plea" });
    expect(h.sent("c1").pop()?.type).toBe("chat_message");

    // Second whisper within 2.5s returns COOLDOWN_ACTIVE
    h.send("c1", {
      type: "send_whisper",
      targetPlayerId: bob.playerId,
      text: "Too fast",
    });
    const cdErr = h.sent("c1").pop();
    expect(cdErr?.type === "error" && cdErr.code).toBe("COOLDOWN_ACTIVE");

    // After 2.5s, whisper succeeds
    h.advanceTime(WHISPER_COOLDOWN_MS);
    h.send("c1", {
      type: "send_whisper",
      targetPlayerId: bob.playerId,
      text: "Now it works",
    });
    expect(h.sent("c1").pop()?.type).toBe("whisper_message");
  });
});

describe("RoomCore Seam — Hybrid Whisper Interception & Doom Penalty", () => {
  it("intercepts at 4 un-leaked whispers, slices to 12 candidates, broadcasts whisper_intercepted, and adds +8% Doom", async () => {
    const { h, alice, bob, cara } = setupThreePlayerActiveRound();

    h.jev.onPickWhisper(async (input) => ({
      roundId: input.roundId,
      whisperId: input.candidates[1]!.id,
    }));

    // Send 4 whispers across different senders (respecting 2.5s per-sender cooldown)
    h.send("c1", {
      type: "send_whisper",
      targetPlayerId: bob.playerId,
      text: "Whisper 1",
    });
    h.send("c2", {
      type: "send_whisper",
      targetPlayerId: cara.playerId,
      text: "Whisper 2 - betray Alice",
    });
    h.send("c3", {
      type: "send_whisper",
      targetPlayerId: alice.playerId,
      text: "Whisper 3",
    });
    h.advanceTime(WHISPER_COOLDOWN_MS);
    h.send("c1", {
      type: "send_whisper",
      targetPlayerId: cara.playerId,
      text: "Whisper 4",
    });

    await h.room.flushPendingEvaluations();

    expect(h.jev.whisperCalls).toHaveLength(1);
    expect(h.jev.whisperCalls[0]!.candidates).toHaveLength(4);

    // Broadcast to entire room (including Alice, Bob, Cara)
    const c1Leaks = h
      .sent("c1")
      .filter((m) => m.type === "whisper_intercepted");
    const c3Leaks = h
      .sent("c3")
      .filter((m) => m.type === "whisper_intercepted");
    expect(c1Leaks).toHaveLength(1);
    expect(c3Leaks).toHaveLength(1);
    const leak = c1Leaks[0]!;
    if (leak.type !== "whisper_intercepted") throw new Error("unreachable");
    expect(leak.senderId).toBe(bob.playerId);
    expect(leak.whisperText).toBe("Whisper 2 - betray Alice");
    expect(leak.headerText).toContain("Bob");
    expect(leak.headerText).toContain("Cara");

    // +8% Doom to Bob (sender of Whisper 2): 50 -> 58
    const doomUpd = h
      .sent("c2")
      .filter((m) => m.type === "doom_updated")
      .pop();
    expect(doomUpd?.type === "doom_updated" && doomUpd.updates[0]).toEqual({
      playerId: bob.playerId,
      doom: 58,
      delta: 8,
    });
  });

  it("enforces 15s minimum gap between interceptions in a round", async () => {
    const { h, alice, bob, cara } = setupThreePlayerActiveRound();

    // First batch of 4 whispers -> leaks at t=0
    h.send("c1", { type: "send_whisper", targetPlayerId: bob.playerId, text: "W1" });
    h.send("c2", { type: "send_whisper", targetPlayerId: cara.playerId, text: "W2" });
    h.send("c3", { type: "send_whisper", targetPlayerId: alice.playerId, text: "W3" });
    h.advanceTime(WHISPER_COOLDOWN_MS);
    h.send("c1", { type: "send_whisper", targetPlayerId: cara.playerId, text: "W4" });
    await h.room.flushPendingEvaluations();
    expect(h.jev.whisperCalls).toHaveLength(1);

    // 4 more whispers arrive within 15s -> must NOT intercept yet
    h.advanceTime(WHISPER_COOLDOWN_MS);
    h.send("c1", { type: "send_whisper", targetPlayerId: bob.playerId, text: "W5" });
    h.send("c2", { type: "send_whisper", targetPlayerId: cara.playerId, text: "W6" });
    h.send("c3", { type: "send_whisper", targetPlayerId: alice.playerId, text: "W7" });
    h.advanceTime(WHISPER_COOLDOWN_MS);
    h.send("c1", { type: "send_whisper", targetPlayerId: cara.playerId, text: "W8" });
    await h.room.flushPendingEvaluations();
    expect(h.jev.whisperCalls).toHaveLength(1);

    // Once 15s gap elapses, alarm triggers the queued interception
    h.advanceTime(10_000);
    await h.room.flushPendingEvaluations();
    expect(h.jev.whisperCalls).toHaveLength(2);
  });

  it("runs single fallback sweep at 25s remaining, skipping Jev when only 1 candidate exists and skipping when 0 exist", async () => {
    // Case A: 0 whispers -> skips Jev at 25s remaining
    const { h: h0 } = setupThreePlayerActiveRound();
    // 3 players => 55s round; 25s remaining is at +30s
    h0.advanceTime(30_000);
    await h0.room.flushPendingEvaluations();
    expect(h0.jev.whisperCalls).toHaveLength(0);

    // Case B: 1 whisper -> skips Jev, leaks directly at 25s remaining
    const { h: h1, alice, bob } = setupThreePlayerActiveRound();
    h1.send("c1", {
      type: "send_whisper",
      targetPlayerId: bob.playerId,
      text: "Only one secret",
    });
    h1.advanceTime(30_000);
    await h1.room.flushPendingEvaluations();
    expect(h1.jev.whisperCalls).toHaveLength(0);
    const leaks = h1
      .sent("c3")
      .filter((m) => m.type === "whisper_intercepted");
    expect(leaks).toHaveLength(1);
    if (leaks[0]?.type === "whisper_intercepted") {
      expect(leaks[0].senderId).toBe(alice.playerId);
      expect(leaks[0].whisperText).toBe("Only one secret");
    }
  });

  it("triggers immediate 100% sacrifice when +8% interception Doom pushes sender to 100%", async () => {
    const { h, alice, bob } = setupThreePlayerActiveRound();
    h.room.setPlayerDoomForMatch(alice.playerId, 95);

    h.send("c1", {
      type: "send_whisper",
      targetPlayerId: bob.playerId,
      text: "Doomed secret",
    });
    h.advanceTime(30_000);
    await h.room.flushPendingEvaluations();

    const phases = h.sent("c2").filter((m) => m.type === "phase_changed");
    const lastPhase = phases.pop();
    expect(lastPhase?.type === "phase_changed" && lastPhase.matchPhase).toBe(
      "SACRIFICE_REVEAL",
    );
    expect(
      lastPhase?.type === "phase_changed" && lastPhase.sacrificedPlayerId,
    ).toBe(alice.playerId);
  });

  it("tracks per-player leaked whisper stats and omits un-leaked whispers from POST_MATCH snapshots", async () => {
    const { h, alice, bob, cara } = setupThreePlayerActiveRound();

    h.send("c1", {
      type: "send_whisper",
      targetPlayerId: bob.playerId,
      text: "Leaked plot",
    });
    // Trigger fallback sweep at 25s remaining
    h.advanceTime(30_000);
    await h.room.flushPendingEvaluations();

    // Send another un-leaked whisper after the leak
    h.advanceTime(WHISPER_COOLDOWN_MS);
    h.send("c2", {
      type: "send_whisper",
      targetPlayerId: cara.playerId,
      text: "Un-leaked secret",
    });

    const stats = h.room.getWhisperStatsForMatch();
    expect(stats.leakedCountByPlayerId[alice.playerId]).toBe(1);
    expect(stats.leakedCountByPlayerId[bob.playerId]).toBe(0);
    expect(stats.lastLeakedWhisper?.text).toBe("Leaked plot");

    // End match -> POST_MATCH snapshot must omit un-leaked whisper but keep whisper_intercepted
    h.room.setPhaseForMatch("POST_MATCH");
    const bobPostSnap = h.reconnect("c2-post", bob.playerToken);
    expect(bobPostSnap.feed?.some((f) => f.kind === "whisper")).toBe(false);
    expect(
      bobPostSnap.feed?.some((f) => f.kind === "whisper_intercepted"),
    ).toBe(true);
  });
});
