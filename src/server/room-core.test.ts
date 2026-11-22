import { describe, it, expect } from "vitest";
import { RoomCore, type RoomTransport, type RoomStorage } from "./room-core.js";
import {
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "../shared/protocol.js";

class FakeRoomHarness {
  now = 1_700_000_000_000;
  alarmAt: number | null = null;
  storedState: string | null = null;
  closedConnections = new Set<string>();
  sentByConnection = new Map<string, ServerMessage[]>();
  private rngCounter = 0;
  readonly room: RoomCore;

  constructor(roomCode = "WXYZ") {
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
    };

    this.room = new RoomCore({
      roomCode,
      transport,
      storage,
      clock: () => this.now,
      generateId: () => `id-${++this.rngCounter}`,
    });
  }

  connect(connectionId: string): void {
    this.closedConnections.delete(connectionId);
    if (!this.sentByConnection.has(connectionId)) {
      this.sentByConnection.set(connectionId, []);
    }
  }

  sendRaw(connectionId: string, raw: string): void {
    this.connect(connectionId);
    this.room.onMessage(connectionId, raw);
  }

  send(connectionId: string, message: ClientMessage): void {
    this.sendRaw(connectionId, JSON.stringify(message));
  }

  disconnect(connectionId: string): void {
    this.closedConnections.add(connectionId);
    this.room.onClose(connectionId);
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

  lastMessageFor(connectionId: string): ServerMessage | undefined {
    const msgs = this.messagesFor(connectionId);
    return msgs[msgs.length - 1];
  }

  clearMessages(): void {
    for (const [k] of this.sentByConnection) {
      this.sentByConnection.set(k, []);
    }
  }
}

describe("Room WebSocket seam — join, validation, preset avatars & capacity", () => {
  it("returns unicast INVALID_PAYLOAD without closing socket on malformed JSON or invalid schema", () => {
    const h = new FakeRoomHarness();
    h.connect("c1");

    h.sendRaw("c1", "{not valid json");
    expect(h.closedConnections.has("c1")).toBe(false);
    expect(h.lastMessageFor("c1")).toMatchObject({
      type: "error",
      code: "INVALID_PAYLOAD",
    });

    h.sendRaw("c1", JSON.stringify({ type: "join", name: "   " }));
    expect(h.closedConnections.has("c1")).toBe(false);
    expect(h.lastMessageFor("c1")).toMatchObject({
      type: "error",
      code: "INVALID_PAYLOAD",
    });
  });

  it("joins first player as Host with auto-assigned preset avatar and enforces unique names & 6-player cap", () => {
    const h = new FakeRoomHarness("ABCK");
    h.send("c1", { type: "join", name: "Alice" });

    const snap1 = h.messagesFor("c1").find((m) => m.type === "room_snapshot");
    expect(snap1).toBeDefined();
    if (snap1?.type !== "room_snapshot") throw new Error("expected snapshot");

    expect(snap1.roomCode).toBe("ABCK");
    expect(snap1.phase).toBe("WAITING");
    expect(snap1.playerToken).toBeTruthy();
    expect(snap1.players).toHaveLength(1);
    expect(snap1.players[0]).toMatchObject({
      id: snap1.selfPlayerId,
      name: "Alice",
      isHost: true,
      connected: true,
    });

    // Case-insensitive duplicate name rejected
    h.send("c2", { type: "join", name: "alice" });
    expect(h.lastMessageFor("c2")).toMatchObject({
      type: "error",
      code: "NAME_TAKEN",
    });

    // Fill up to 6 unique players
    const names = ["Bob", "Cara", "Dan", "Eve", "Fay"];
    names.forEach((name, idx) => {
      h.send(`c${idx + 2}`, { type: "join", name });
    });

    const snap6 = h.messagesFor("c6").find((m) => m.type === "room_snapshot");
    expect(snap6?.type).toBe("room_snapshot");
    if (snap6?.type !== "room_snapshot") throw new Error("expected snapshot");
    expect(snap6.players).toHaveLength(6);

    // Every player received a unique preset avatar
    const avatars = new Set(snap6.players.map((p) => p.avatarId));
    expect(avatars.size).toBe(6);

    // 7th player rejected with ROOM_FULL
    h.send("c7", { type: "join", name: "Gus" });
    expect(h.lastMessageFor("c7")).toMatchObject({
      type: "error",
      code: "ROOM_FULL",
    });
  });

  it("allows avatar swaps in WAITING and rejects taken avatars with AVATAR_TAKEN", () => {
    const h = new FakeRoomHarness();
    h.send("c1", { type: "join", name: "Alice", avatarId: "skull" });
    h.send("c2", { type: "join", name: "Bob", avatarId: "raven" });

    // Bob tries to take Alice's skull -> AVATAR_TAKEN
    h.send("c2", { type: "swap_avatar", avatarId: "skull" });
    expect(h.lastMessageFor("c2")).toMatchObject({
      type: "error",
      code: "AVATAR_TAKEN",
    });

    // Bob swaps to unused crown -> broadcast player_updated
    h.clearMessages();
    h.send("c2", { type: "swap_avatar", avatarId: "crown" });

    const updateForAlice = h.lastMessageFor("c1");
    expect(updateForAlice?.type).toBe("player_updated");
    if (updateForAlice?.type !== "player_updated") throw new Error("expected update");
    const bob = updateForAlice.players.find((p) => p.name === "Bob");
    expect(bob?.avatarId).toBe("crown");
  });

  it("allows Host to kick another player in WAITING and rejects non-Host with NOT_HOST", () => {
    const h = new FakeRoomHarness();
    h.send("c1", { type: "join", name: "Alice" });
    h.send("c2", { type: "join", name: "Bob" });

    const snap1 = h.messagesFor("c1").find((m) => m.type === "room_snapshot");
    const snap2 = h.messagesFor("c2").find((m) => m.type === "room_snapshot");
    if (snap1?.type !== "room_snapshot" || snap2?.type !== "room_snapshot") {
      throw new Error("expected snapshots");
    }
    const aliceId = snap1.selfPlayerId;
    const bobId = snap2.selfPlayerId;

    // Non-Host Bob tries to kick Alice -> NOT_HOST
    h.send("c2", { type: "kick_player", targetPlayerId: aliceId });
    expect(h.lastMessageFor("c2")).toMatchObject({
      type: "error",
      code: "NOT_HOST",
    });
    expect(h.closedConnections.has("c1")).toBe(false);

    // Host Alice kicks Bob -> unicast kicked + socket closed + roster broadcast
    h.clearMessages();
    h.send("c1", { type: "kick_player", targetPlayerId: bobId });

    expect(h.lastMessageFor("c2")).toMatchObject({
      type: "kicked",
      reason: expect.any(String),
    });
    expect(h.closedConnections.has("c2")).toBe(true);

    const updateForAlice = h.lastMessageFor("c1");
    expect(updateForAlice?.type).toBe("player_updated");
    if (updateForAlice?.type !== "player_updated") throw new Error("expected update");
    expect(updateForAlice.players.map((p) => p.name)).toEqual(["Alice"]);
  });

  it("transfers Host to longest-standing remaining player on explicit leave_room immediately", () => {
    const h = new FakeRoomHarness();
    h.send("c1", { type: "join", name: "Alice" });
    h.advanceTime(1_000);
    h.send("c2", { type: "join", name: "Bob" });
    h.advanceTime(1_000);
    h.send("c3", { type: "join", name: "Cara" });

    h.clearMessages();
    h.send("c1", { type: "leave_room" });

    expect(h.closedConnections.has("c1")).toBe(true);
    expect(h.alarmAt).toBeNull();

    const updateForBob = h.lastMessageFor("c2");
    expect(updateForBob?.type).toBe("player_updated");
    if (updateForBob?.type !== "player_updated") throw new Error("expected update");
    expect(updateForBob.players.map((p) => ({ name: p.name, isHost: p.isHost }))).toEqual([
      { name: "Bob", isHost: true },
      { name: "Cara", isHost: false },
    ]);
  });

  it("grants a 30s disconnect grace in WAITING, expires seat & transfers Host after 30s", () => {
    const h = new FakeRoomHarness();
    h.send("c1", { type: "join", name: "Alice" });
    h.advanceTime(1_000);
    h.send("c2", { type: "join", name: "Bob" });

    h.clearMessages();
    h.disconnect("c1");

    // Still present as disconnected during grace period
    const afterDisconnect = h.lastMessageFor("c2");
    expect(afterDisconnect?.type).toBe("player_updated");
    if (afterDisconnect?.type !== "player_updated") throw new Error("expected update");
    expect(afterDisconnect.players).toHaveLength(2);
    expect(afterDisconnect.players.find((p) => p.name === "Alice")).toMatchObject({
      connected: false,
      isHost: true,
    });
    expect(h.alarmAt).toBe(h.now + 30_000);

    // At 29s, Alice is still in the Room
    h.advanceTime(29_000);
    expect(h.alarmAt).not.toBeNull();

    // At 30s, alarm fires: Alice removed and Bob becomes Host
    h.clearMessages();
    h.advanceTime(1_000);
    const afterExpiry = h.lastMessageFor("c2");
    expect(afterExpiry?.type).toBe("player_updated");
    if (afterExpiry?.type !== "player_updated") throw new Error("expected update");
    expect(afterExpiry.players.map((p) => ({ name: p.name, isHost: p.isHost }))).toEqual([
      { name: "Bob", isHost: true },
    ]);
  });

  it("restores exact seat on reconnect with valid playerToken without leaking other players' tokens", () => {
    const h = new FakeRoomHarness();
    h.send("c1", { type: "join", name: "Alice", avatarId: "dagger" });
    h.send("c2", { type: "join", name: "Bob", avatarId: "moth" });

    const snap1 = h.messagesFor("c1").find((m) => m.type === "room_snapshot");
    const snap2 = h.messagesFor("c2").find((m) => m.type === "room_snapshot");
    if (snap1?.type !== "room_snapshot" || snap2?.type !== "room_snapshot") {
      throw new Error("expected snapshots");
    }

    // Privacy check: serialized snapshot for Alice must never contain Bob's playerToken
    expect(JSON.stringify(snap1)).not.toContain(snap2.playerToken);
    expect(JSON.stringify(snap2)).not.toContain(snap1.playerToken);

    // Alice disconnects and reconnects before 30s grace expires
    h.disconnect("c1");
    h.advanceTime(10_000);
    h.clearMessages();

    h.send("c1-reconnected", { type: "join", playerToken: snap1.playerToken });

    const reconSnap = h.messagesFor("c1-reconnected").find((m) => m.type === "room_snapshot");
    expect(reconSnap?.type).toBe("room_snapshot");
    if (reconSnap?.type !== "room_snapshot") throw new Error("expected reconnect snapshot");

    expect(reconSnap.selfPlayerId).toBe(snap1.selfPlayerId);
    expect(reconSnap.playerToken).toBe(snap1.playerToken);
    expect(reconSnap.players.find((p) => p.id === snap1.selfPlayerId)).toMatchObject({
      name: "Alice",
      avatarId: "dagger",
      isHost: true,
      connected: true,
    });
    expect(JSON.stringify(reconSnap)).not.toContain(snap2.playerToken);

    // Grace timer cancelled — advancing 30s does not remove Alice
    h.advanceTime(30_000);
    expect(h.alarmAt).toBeNull();
  });

  it("rejects new joiners with ROOM_LOCKED when IN_MATCH or POST_MATCH while allowing token reconnect", () => {
    const h = new FakeRoomHarness();
    h.send("c1", { type: "join", name: "Alice" });
    const snap1 = h.messagesFor("c1").find((m) => m.type === "room_snapshot");
    if (snap1?.type !== "room_snapshot") throw new Error("expected snapshot");

    h.room.setPhaseForMatch("IN_MATCH", h.now + 60_000);

    // New joiner rejected with ROOM_LOCKED
    h.send("c2", { type: "join", name: "Bob" });
    expect(h.lastMessageFor("c2")).toMatchObject({
      type: "error",
      code: "ROOM_LOCKED",
    });

    // Existing player with valid token reconnects cleanly
    h.disconnect("c1");
    h.send("c1-re", { type: "join", playerToken: snap1.playerToken });
    expect(h.lastMessageFor("c1-re")).toMatchObject({
      type: "room_snapshot",
      phase: "IN_MATCH",
      selfPlayerId: snap1.selfPlayerId,
    });
  });

  it("restores Room state from persisted storage after Durable Object hibernation wakeup", () => {
    const h1 = new FakeRoomHarness("QWER");
    h1.send("c1", { type: "join", name: "Alice", avatarId: "lantern" });
    const snap1 = h1.messagesFor("c1").find((m) => m.type === "room_snapshot");
    if (snap1?.type !== "room_snapshot") throw new Error("expected snapshot");
    expect(h1.storedState).not.toBeNull();

    // Simulate Durable Object waking up from hibernation with the same persisted state
    const h2 = new FakeRoomHarness("QWER");
    h2.storedState = h1.storedState;
    const restored = new RoomCore({
      roomCode: "QWER",
      transport: {
        send: (connId, payload) => {
          const list = h2.sentByConnection.get(connId) ?? [];
          list.push(ServerMessageSchema.parse(JSON.parse(payload)));
          h2.sentByConnection.set(connId, list);
        },
        broadcast: () => {},
        close: () => {},
      },
      storage: {
        load: () => h2.storedState,
        save: (json) => {
          h2.storedState = json;
        },
        scheduleAlarm: (at) => {
          h2.alarmAt = at;
        },
      },
      clock: () => h2.now,
    });

    restored.onMessage(
      "c1-woke",
      JSON.stringify({ type: "join", playerToken: snap1.playerToken }),
    );
    const wokeSnap = h2.messagesFor("c1-woke").find((m) => m.type === "room_snapshot");
    expect(wokeSnap).toMatchObject({
      type: "room_snapshot",
      roomCode: "QWER",
      selfPlayerId: snap1.selfPlayerId,
      playerToken: snap1.playerToken,
    });
  });
});

describe("Room WebSocket seam — Match loop, timers, Doom soft-reset & live public pleading", () => {
  it("allows Host to start a 2-6 player Match, rejects non-Hosts and <2 players, and locks Room to new joiners", () => {
    const h = new FakeRoomHarness();
    h.send("c1", { type: "join", name: "Alice" });

    // Fewer than 2 players -> rejected
    h.send("c1", { type: "start_match" });
    expect(h.lastMessageFor("c1")).toMatchObject({
      type: "error",
      code: "INVALID_PAYLOAD",
    });

    h.send("c2", { type: "join", name: "Bob" });

    // Non-Host -> NOT_HOST
    h.send("c2", { type: "start_match" });
    expect(h.lastMessageFor("c2")).toMatchObject({
      type: "error",
      code: "NOT_HOST",
    });

    h.clearMessages();
    const startTime = h.now;
    h.send("c1", { type: "start_match" });

    const phaseMsg = h
      .messagesFor("c1")
      .find((m) => m.type === "phase_changed");
    expect(phaseMsg).toMatchObject({
      type: "phase_changed",
      phase: "IN_MATCH",
      matchPhase: "ROUND_INTRO",
      round: 1,
      totalRounds: 1,
      serverNow: startTime,
      phaseEndsAt: startTime + 3500,
    });
    if (phaseMsg?.type !== "phase_changed") throw new Error("expected phase_changed");
    expect(phaseMsg.players.every((p) => p.alive && p.doom === 50)).toBe(true);

    // Room is now locked to new joiners
    h.send("c3", { type: "join", name: "Carol" });
    expect(h.lastMessageFor("c3")).toMatchObject({
      type: "error",
      code: "ROOM_LOCKED",
    });
  });

  it("runs a 2-player Match with 60s ROUND_ACTIVE, eliminates highest-Doom player into Ghost, and ends in POST_MATCH", () => {
    const h = new FakeRoomHarness();
    h.send("c1", { type: "join", name: "Alice" });
    h.send("c2", { type: "join", name: "Bob" });
    const snap2 = h.messagesFor("c2").find((m) => m.type === "room_snapshot");
    if (snap2?.type !== "room_snapshot") throw new Error("expected snapshot");

    h.send("c1", { type: "start_match" });
    h.clearMessages();

    // Advance past ROUND_INTRO (3500ms) -> ROUND_ACTIVE (60_000ms for 2p)
    h.advanceTime(3500);
    expect(h.lastMessageFor("c1")).toMatchObject({
      type: "phase_changed",
      phase: "IN_MATCH",
      matchPhase: "ROUND_ACTIVE",
      round: 1,
      serverNow: h.now,
      phaseEndsAt: h.now + 60_000,
    });

    // Give Bob higher Doom so Bob is claimed at round end
    h.room.setPlayerDoomForMatch(snap2.selfPlayerId, 78);

    // Advance 60_000ms -> ROUND_RESOLVING (2000ms)
    h.clearMessages();
    h.advanceTime(60_000);
    expect(h.lastMessageFor("c1")).toMatchObject({
      type: "phase_changed",
      phase: "IN_MATCH",
      matchPhase: "ROUND_RESOLVING",
      serverNow: h.now,
      phaseEndsAt: h.now + 2000,
    });

    // Advance 2000ms -> SACRIFICE_REVEAL (4500ms) with Bob as Ghost
    h.clearMessages();
    h.advanceTime(2000);
    const revealMsg = h
      .messagesFor("c1")
      .find((m) => m.type === "phase_changed");
    expect(revealMsg).toMatchObject({
      type: "phase_changed",
      phase: "IN_MATCH",
      matchPhase: "SACRIFICE_REVEAL",
      sacrificedPlayerId: snap2.selfPlayerId,
      serverNow: h.now,
      phaseEndsAt: h.now + 4500,
    });
    if (revealMsg?.type !== "phase_changed") throw new Error("expected phase_changed");
    const bobAfterReveal = revealMsg.players.find(
      (p) => p.id === snap2.selfPlayerId,
    );
    expect(bobAfterReveal?.alive).toBe(false);

    // Advance 4500ms -> POST_MATCH with Alice as winner
    h.clearMessages();
    h.advanceTime(4500);
    expect(h.lastMessageFor("c1")).toMatchObject({
      type: "phase_changed",
      phase: "POST_MATCH",
      matchPhase: null,
      endReason: "SURVIVOR",
      phaseEndsAt: null,
    });
  });

  it("follows the 6->90s, 5->75s, 4->65s, 3->55s, 2->45s duration curve and soft-resets Doom between rounds", () => {
    const h = new FakeRoomHarness();
    const ids: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const cid = `c${i}`;
      h.send(cid, { type: "join", name: `P${i}` });
      const snap = h.messagesFor(cid).find((m) => m.type === "room_snapshot");
      if (snap?.type !== "room_snapshot") throw new Error("expected snapshot");
      ids.push(snap.selfPlayerId);
    }

    h.send("c1", { type: "start_match" });

    const expectedDurations = [90_000, 75_000, 65_000, 55_000, 45_000];
    for (let r = 0; r < expectedDurations.length; r++) {
      const expectedMs = expectedDurations[r]!;
      h.clearMessages();
      h.advanceTime(3500); // ROUND_INTRO -> ROUND_ACTIVE
      const activeMsg = h.lastMessageFor("c1");
      expect(activeMsg).toMatchObject({
        type: "phase_changed",
        matchPhase: "ROUND_ACTIVE",
        round: r + 1,
        phaseEndsAt: h.now + expectedMs,
      });

      // Set highest Doom on victim P(6-r), and set P1 to 81% on round 1 to test soft-reset
      if (r === 0) {
        h.room.setPlayerDoomForMatch(ids[0]!, 81); // round((81+50)/2) = 66
      }
      const victimId = ids[5 - r]!;
      h.room.setPlayerDoomForMatch(victimId, 95);

      h.advanceTime(expectedMs); // -> ROUND_RESOLVING
      h.advanceTime(2000); // -> SACRIFICE_REVEAL
      h.clearMessages();
      h.advanceTime(4500); // -> next ROUND_INTRO or POST_MATCH

      const nextPhase = h
        .messagesFor("c1")
        .find((m) => m.type === "phase_changed");
      if (nextPhase?.type !== "phase_changed") throw new Error("expected phase_changed");
      if (r === 0) {
        // Verify Doom soft-reset: round((81 + 50) / 2) = 66
        const p1 = nextPhase.players.find((p) => p.id === ids[0]);
        expect(p1?.doom).toBe(66);
      }
      if (r === expectedDurations.length - 1) {
        expect(nextPhase.phase).toBe("POST_MATCH");
        expect(nextPhase.winnerId).toBe(ids[0]);
      } else {
        expect(nextPhase.matchPhase).toBe("ROUND_INTRO");
        expect(nextPhase.round).toBe(r + 2);
      }
    }
  });

  it("gates public chat to ROUND_ACTIVE living players, enforces 2-200 chars & 2.5s cooldown, and broadcasts immediately", () => {
    const h = new FakeRoomHarness();
    h.send("c1", { type: "join", name: "Alice" });
    h.send("c2", { type: "join", name: "Bob" });
    h.send("c3", { type: "join", name: "Carol" });
    const snap3 = h.messagesFor("c3").find((m) => m.type === "room_snapshot");
    if (snap3?.type !== "room_snapshot") throw new Error("expected snapshot");

    h.send("c1", { type: "start_match" });

    // Rejected during ROUND_INTRO
    h.send("c1", { type: "send_chat", text: "Spare me!" });
    expect(h.lastMessageFor("c1")).toMatchObject({
      type: "error",
      code: "INVALID_PAYLOAD",
    });

    // Advance to ROUND_ACTIVE
    h.advanceTime(3500);

    // Too short (< 2 chars) or too long (> 200 chars) -> INVALID_PAYLOAD
    h.send("c1", { type: "send_chat", text: " a " });
    expect(h.lastMessageFor("c1")).toMatchObject({
      type: "error",
      code: "INVALID_PAYLOAD",
    });
    h.send("c1", { type: "send_chat", text: "x".repeat(201) });
    expect(h.lastMessageFor("c1")).toMatchObject({
      type: "error",
      code: "INVALID_PAYLOAD",
    });

    // Valid chat broadcasts immediately to all players
    h.clearMessages();
    h.send("c1", { type: "send_chat", text: "I am innocent!" });
    expect(h.lastMessageFor("c1")).toMatchObject({
      type: "chat_message",
      playerName: "Alice",
      text: "I am innocent!",
    });
    expect(h.lastMessageFor("c2")).toMatchObject({
      type: "chat_message",
      playerName: "Alice",
      text: "I am innocent!",
    });

    // 2.5s cooldown enforced for Alice, but Bob can speak immediately
    h.advanceTime(1000);
    h.send("c1", { type: "send_chat", text: "Please believe me!" });
    expect(h.lastMessageFor("c1")).toMatchObject({
      type: "error",
      code: "COOLDOWN_ACTIVE",
      retryAfterMs: 1500,
    });

    h.send("c2", { type: "send_chat", text: "Alice is lying!" });
    expect(h.lastMessageFor("c2")).toMatchObject({
      type: "chat_message",
      playerName: "Bob",
      text: "Alice is lying!",
    });

    // After remaining 1500ms, Alice can speak again
    h.advanceTime(1500);
    h.send("c1", { type: "send_chat", text: "Look at Carol!" });
    expect(h.lastMessageFor("c1")).toMatchObject({
      type: "chat_message",
      playerName: "Alice",
      text: "Look at Carol!",
    });

    // Eliminate Carol -> Round 2 -> Ghosts cannot send public chat
    h.room.setPlayerDoomForMatch(snap3.selfPlayerId, 99);
    h.advanceTime(65_000 - 2500); // finish ROUND_ACTIVE
    h.advanceTime(2000); // ROUND_RESOLVING -> SACRIFICE_REVEAL
    h.advanceTime(4500); // -> Round 2 ROUND_INTRO
    h.advanceTime(3500); // -> Round 2 ROUND_ACTIVE

    h.send("c3", { type: "send_chat", text: "Ghost speaking!" });
    expect(h.lastMessageFor("c3")).toMatchObject({
      type: "error",
      code: "INVALID_PAYLOAD",
    });
  });
});
