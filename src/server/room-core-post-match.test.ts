import { describe, it, expect } from "vitest";
import { RoomCore, type RoomTransport, type RoomStorage } from "./room-core.js";
import {
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "../shared/protocol.js";
import type { JevEvaluator } from "./jev.js";
import { POST_MATCH_JUDGE_ERROR } from "./copy/script-bank.js";

class FakePostMatchHarness {
  now = 1_700_000_000_000;
  alarmAt: number | null = null;
  storedState: string | null = null;
  closedConnections = new Set<string>();
  sentByConnection = new Map<string, ServerMessage[]>();
  private rngCounter = 0;
  readonly room: RoomCore;

  constructor(jevEvaluator?: JevEvaluator, random = () => 0.1) {
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
        this.alarmAt = null;
      },
    };

    this.room = new RoomCore({
      roomCode: "POST",
      transport,
      storage,
      clock: () => this.now,
      generateId: () => `id-${++this.rngCounter}`,
      random,
      jevEvaluator,
    });
  }

  connect(connectionId: string): void {
    this.closedConnections.delete(connectionId);
    if (!this.sentByConnection.has(connectionId)) {
      this.sentByConnection.set(connectionId, []);
    }
  }

  send(connectionId: string, message: ClientMessage): void {
    this.connect(connectionId);
    this.room.onMessage(connectionId, JSON.stringify(message));
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

  lastPhaseChanged(
    connectionId: string,
  ): Extract<ServerMessage, { type: "phase_changed" }> | undefined {
    const msgs = this.messagesFor(connectionId).filter(
      (m): m is Extract<ServerMessage, { type: "phase_changed" }> =>
        m.type === "phase_changed",
    );
    return msgs[msgs.length - 1];
  }

  lastSnapshot(
    connectionId: string,
  ): Extract<ServerMessage, { type: "room_snapshot" }> | undefined {
    const msgs = this.messagesFor(connectionId).filter(
      (m): m is Extract<ServerMessage, { type: "room_snapshot" }> =>
        m.type === "room_snapshot",
    );
    return msgs[msgs.length - 1];
  }
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Room WebSocket seam — POST_MATCH summary, conditional awards, log privacy & rematch", () => {
  it("emits SURVIVOR postMatchSummary with elimination timeline and triggered awards (Closest Call >=75%, Curse Magnet, Exposed)", async () => {
    const mockJev: JevEvaluator = {
      judgeMessage: async ({ roundId, messageText }) => {
        if (messageText.includes("spike")) {
          return {
            roundId,
            persuasivenessScore: 0,
            targetBlamed: "NONE",
            targetBlamedConfidence: 0,
            isLowEffortSpamNoul: 0,
          };
        }
        return {
          roundId,
          persuasivenessScore: 100,
          targetBlamed: "NONE",
          targetBlamedConfidence: 0,
          isLowEffortSpamNoul: 0,
        };
      },
      pickInterceptedWhisper: async ({ roundId, candidates }) => ({
        roundId,
        whisperId: candidates[0]!.id,
      }),
    };

    const h = new FakePostMatchHarness(mockJev);
    h.send("c1", { type: "join", name: "Alice", avatarId: "skull" });
    h.send("c2", { type: "join", name: "Bob", avatarId: "raven" });
    h.send("c3", { type: "join", name: "Carol", avatarId: "moth" });

    const snap3 = h.lastSnapshot("c3")!;
    const aliceId = snap3.players.find((p) => p.name === "Alice")!.id;
    const bobId = snap3.players.find((p) => p.name === "Bob")!.id;
    const carolId = snap3.players.find((p) => p.name === "Carol")!.id;

    h.send("c1", { type: "start_match" });
    h.advanceTime(3500); // Round 1 ROUND_ACTIVE (65s)

    // Round 1: Alice reaches 85% doom, then recovers with a good plea (peakSurvivedDoom = 85 >= 75!)
    h.room.setPlayerDoomForMatch(aliceId, 85);
    h.send("c1", { type: "send_chat", text: "spare me entity" });
    await flushAsync();

    // Carol hits 90% and is sacrificed at timer end
    h.room.setPlayerDoomForMatch(carolId, 90);
    // Send 4 whispers so interception triggers and leaks one
    h.send("c2", { type: "send_whisper", targetPlayerId: aliceId, text: "secret 1" });
    h.advanceTime(2600);
    h.send("c2", { type: "send_whisper", targetPlayerId: aliceId, text: "secret 2" });
    h.advanceTime(2600);
    h.send("c2", { type: "send_whisper", targetPlayerId: aliceId, text: "secret 3" });
    h.advanceTime(2600);
    h.send("c2", { type: "send_whisper", targetPlayerId: aliceId, text: "secret 4" });
    await flushAsync();

    // Expire Round 1 -> ROUND_RESOLVING -> SACRIFICE_REVEAL (Carol)
    h.advanceTime(120_000);
    h.advanceTime(2_000);
    expect(h.lastPhaseChanged("c1")?.matchPhase).toBe("SACRIFICE_REVEAL");

    // Expire SACRIFICE_REVEAL -> Round 2 ROUND_INTRO -> ROUND_ACTIVE
    h.advanceTime(4_500);
    h.advanceTime(3_500);

    // Carol (Ghost) casts a Curse on Alice
    h.send("c3", { type: "cast_curse", targetPlayerId: aliceId, word: "mercy" });

    // Bob hits 100% doom -> immediate sacrifice -> POST_MATCH SURVIVOR (Alice)
    h.room.setPlayerDoomForMatch(bobId, 95);
    h.send("c2", { type: "send_chat", text: "please spike me" });
    await flushAsync();

    // Expire SACRIFICE_REVEAL -> POST_MATCH
    h.advanceTime(4_500);

    const postPhase = h.lastPhaseChanged("c1");
    expect(postPhase?.phase).toBe("POST_MATCH");
    expect(postPhase?.endReason).toBe("SURVIVOR");
    expect(postPhase?.winnerId).toBe(aliceId);
    expect(postPhase?.postMatchSummary).toBeDefined();

    const summary = postPhase!.postMatchSummary!;
    expect(summary.endReason).toBe("SURVIVOR");
    expect(summary.winnerId).toBe(aliceId);
    expect(summary.closingBeat.length).toBeGreaterThan(0);
    expect(summary.eliminations).toEqual([
      {
        round: 1,
        playerId: carolId,
        playerName: "Carol",
        avatarId: "moth",
        cause: "TIMER",
      },
      {
        round: 2,
        playerId: bobId,
        playerName: "Bob",
        avatarId: "raven",
        cause: "SPIKE",
      },
    ]);
    expect(summary.awards).toEqual([
      {
        id: "closest_call",
        title: "Closest Call",
        playerId: aliceId,
        playerName: "Alice",
        detail: "85% peak Doom",
      },
      {
        id: "curse_magnet",
        title: "Curse Magnet",
        playerId: aliceId,
        playerName: "Alice",
        detail: "1 Curse endured",
      },
      {
        id: "exposed",
        title: "Exposed",
        playerId: bobId,
        playerName: "Bob",
        detail: 'To Alice: "secret 1"',
      },
    ]);
  });

  it("omits untriggered awards (including peak >=75% only on sacrificed round) and supports ALL_CLAIMED and JUDGE_ERROR summaries", async () => {
    const h = new FakePostMatchHarness();
    h.send("c1", { type: "join", name: "Alice", avatarId: "skull" });
    h.send("c2", { type: "join", name: "Bob", avatarId: "raven" });
    const snap2 = h.lastSnapshot("c2")!;
    const aliceId = snap2.players.find((p) => p.name === "Alice")!.id;
    const bobId = snap2.players.find((p) => p.name === "Bob")!.id;

    h.send("c1", { type: "start_match" });
    h.advanceTime(3500); // ROUND_ACTIVE

    // Alice stays at 74% (< 75% threshold); Bob hits 95% and is sacrificed at timer end
    h.room.setPlayerDoomForMatch(aliceId, 74);
    h.room.setPlayerDoomForMatch(bobId, 95);
    h.advanceTime(120_000);
    h.advanceTime(2_000);
    h.advanceTime(4_500);

    const postPhase = h.lastPhaseChanged("c1");
    expect(postPhase?.phase).toBe("POST_MATCH");
    expect(postPhase?.postMatchSummary?.awards).toEqual([]);

    // Also verify JUDGE_ERROR summary via failing Jev evaluator
    const failingJev: JevEvaluator = {
      judgeMessage: async () => {
        throw new Error("Upstream API key invalid");
      },
      pickInterceptedWhisper: async () => {
        throw new Error("Upstream API key invalid");
      },
    };
    const hErr = new FakePostMatchHarness(failingJev);
    hErr.send("c1", { type: "join", name: "Alice", avatarId: "skull" });
    hErr.send("c2", { type: "join", name: "Bob", avatarId: "raven" });
    hErr.send("c1", { type: "start_match" });
    hErr.advanceTime(3500);
    hErr.send("c1", { type: "send_chat", text: "help me" });
    await flushAsync();

    const errPhase = hErr.lastPhaseChanged("c1");
    expect(errPhase?.phase).toBe("POST_MATCH");
    expect(errPhase?.endReason).toBe("JUDGE_ERROR");
    expect(errPhase?.winnerId).toBeNull();
    expect(errPhase?.postMatchSummary).toEqual({
      endReason: "JUDGE_ERROR",
      winnerId: null,
      closingBeat: POST_MATCH_JUDGE_ERROR,
      eliminations: [],
      awards: [],
    });
  });

  it("enforces Host-only play_again, resets Room to WAITING preserving players/names/avatars/Host, clears logs/counters, and reopens seats up to 6", () => {
    const h = new FakePostMatchHarness();
    h.send("c1", { type: "join", name: "Alice", avatarId: "skull" });
    h.send("c2", { type: "join", name: "Bob", avatarId: "raven" });
    const snap2 = h.lastSnapshot("c2")!;
    const bobId = snap2.players.find((p) => p.name === "Bob")!.id;

    // Cannot play_again while WAITING
    h.send("c1", { type: "play_again" });
    const waitErr = h.messagesFor("c1").at(-1);
    expect(waitErr?.type).toBe("error");

    h.send("c1", { type: "start_match" });
    h.advanceTime(3500);
    h.room.setPlayerDoomForMatch(bobId, 95);
    h.advanceTime(120_000);
    h.advanceTime(2_000);
    h.advanceTime(4_500);
    expect(h.lastPhaseChanged("c1")?.phase).toBe("POST_MATCH");

    // Non-Host Bob cannot trigger play_again
    h.send("c2", { type: "play_again" });
    const notHostErr = h.messagesFor("c2").at(-1);
    expect(notHostErr).toMatchObject({ type: "error", code: "NOT_HOST" });

    // Host Alice triggers play_again
    h.send("c1", { type: "play_again" });
    const waitPhase = h.lastPhaseChanged("c1");
    expect(waitPhase?.phase).toBe("WAITING");
    expect(waitPhase?.matchPhase).toBeNull();
    expect(waitPhase?.round).toBe(0);
    expect(waitPhase?.postMatchSummary).toBeNull();
    expect(waitPhase?.players.map((p) => ({ name: p.name, avatarId: p.avatarId, isHost: p.isHost, alive: p.alive, doom: p.doom }))).toEqual([
      { name: "Alice", avatarId: "skull", isHost: true, alive: true, doom: 50 },
      { name: "Bob", avatarId: "raven", isHost: false, alive: true, doom: 50 },
    ]);

    // Reconnecting/new player can now join reopened seats and feed is cleared
    h.send("c3", { type: "join", name: "Carol", avatarId: "moth" });
    const snap3 = h.lastSnapshot("c3")!;
    expect(snap3.phase).toBe("WAITING");
    expect(snap3.feed).toEqual([]);
    expect(snap3.players).toHaveLength(3);
  });

  it("handles POST_MATCH leave_room with immediate removal + Host transfer, 30s disconnect grace, ROOM_LOCKED, and Match log privacy", () => {
    const h = new FakePostMatchHarness();
    h.send("c1", { type: "join", name: "Alice", avatarId: "skull" });
    h.send("c2", { type: "join", name: "Bob", avatarId: "raven" });
    h.send("c3", { type: "join", name: "Carol", avatarId: "moth" });
    const snap3 = h.lastSnapshot("c3")!;
    const bobId = snap3.players.find((p) => p.name === "Bob")!.id;
    const carolId = snap3.players.find((p) => p.name === "Carol")!.id;

    h.send("c1", { type: "start_match" });
    h.advanceTime(3500);
    // Send a private whisper that is NOT leaked
    h.send("c2", { type: "send_whisper", targetPlayerId: carolId, text: "unleaked secret" });

    // End match via Carol & Bob sacrifice
    h.room.setPlayerDoomForMatch(carolId, 95);
    h.advanceTime(120_000);
    h.advanceTime(2_000);
    h.advanceTime(4_500);
    h.advanceTime(3_500);
    h.room.setPlayerDoomForMatch(bobId, 95);
    h.advanceTime(120_000);
    h.advanceTime(2_000);
    h.advanceTime(4_500);
    expect(h.lastPhaseChanged("c1")?.phase).toBe("POST_MATCH");

    // New joiner is rejected with ROOM_LOCKED in POST_MATCH
    h.send("c4", { type: "join", name: "Dave", avatarId: "chalice" });
    expect(h.messagesFor("c4").at(-1)).toMatchObject({
      type: "error",
      code: "ROOM_LOCKED",
    });

    // Reconnect Bob in POST_MATCH -> snapshot feed omits un-leaked whisper
    const bobToken = h.lastSnapshot("c2")!.playerToken;
    h.send("c2b", { type: "join", playerToken: bobToken });
    const bobReconnectSnap = h.lastSnapshot("c2b")!;
    expect(bobReconnectSnap.feed?.some((f) => f.kind === "whisper")).toBe(false);

    // Host Alice explicitly leaves -> immediate removal + Host transfers to Bob
    h.send("c1", { type: "leave_room" });
    expect(h.closedConnections.has("c1")).toBe(true);
    const afterLeave = h.messagesFor("c2b").at(-1);
    expect(afterLeave?.type).toBe("player_updated");
    if (afterLeave?.type === "player_updated") {
      expect(afterLeave.players.map((p) => p.name)).toEqual(["Bob", "Carol"]);
      expect(afterLeave.players.find((p) => p.name === "Bob")?.isHost).toBe(true);
    }

    // Carol disconnects -> 30s grace keeps her until 30s elapses
    h.disconnect("c3");
    h.advanceTime(29_999);
    expect(h.messagesFor("c2b").at(-1)).toMatchObject({
      type: "player_updated",
    });
    h.advanceTime(1);
    const afterGrace = h.messagesFor("c2b").at(-1);
    if (afterGrace?.type === "player_updated") {
      expect(afterGrace.players.map((p) => p.name)).toEqual(["Bob"]);
    }
  });

  it("emits match_ended server event on SURVIVOR and JUDGE_ERROR match endings", async () => {
    const h = new FakePostMatchHarness();
    h.send("c1", { type: "join", name: "Alice", avatarId: "skull" });
    h.send("c2", { type: "join", name: "Bob", avatarId: "raven" });
    const snap2 = h.lastSnapshot("c2")!;
    const aliceId = snap2.players.find((p) => p.name === "Alice")!.id;
    const bobId = snap2.players.find((p) => p.name === "Bob")!.id;

    h.send("c1", { type: "start_match" });
    h.advanceTime(3500);
    h.room.setPlayerDoomForMatch(bobId, 95);
    h.advanceTime(120_000);
    h.advanceTime(2_000);
    h.advanceTime(4_500);

    const matchEnded = h
      .messagesFor("c1")
      .filter((m) => m.type === "match_ended")
      .at(-1);
    expect(matchEnded).toMatchObject({
      type: "match_ended",
      roomStatus: "POST_MATCH",
      endReason: "SURVIVOR",
      winnerId: aliceId,
      postMatchSummary: {
        endReason: "SURVIVOR",
        winnerId: aliceId,
      },
    });

    const failingJev: JevEvaluator = {
      judgeMessage: async () => {
        throw new Error("Jev offline");
      },
      pickInterceptedWhisper: async () => {
        throw new Error("Jev offline");
      },
    };
    const hErr = new FakePostMatchHarness(failingJev);
    hErr.send("c1", { type: "join", name: "Alice", avatarId: "skull" });
    hErr.send("c2", { type: "join", name: "Bob", avatarId: "raven" });
    hErr.send("c1", { type: "start_match" });
    hErr.advanceTime(3500);
    hErr.send("c1", { type: "send_chat", text: "help me" });
    await flushAsync();

    const errMatchEnded = hErr
      .messagesFor("c1")
      .filter((m) => m.type === "match_ended")
      .at(-1);
    expect(errMatchEnded).toMatchObject({
      type: "match_ended",
      roomStatus: "POST_MATCH",
      endReason: "JUDGE_ERROR",
      winnerId: null,
      postMatchSummary: {
        endReason: "JUDGE_ERROR",
        winnerId: null,
      },
    });
  });
});
