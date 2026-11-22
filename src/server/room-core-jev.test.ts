import { describe, it, expect } from "vitest";
import { RoomCore, type RoomStorage, type RoomTransport } from "./room-core.js";
import {
  ENTITY_MOODS,
  type EntityMood,
  type JevEvaluator,
  type JudgeMessageInput,
  type JudgeMessageResult,
  type PickInterceptedWhisperInput,
  type PickInterceptedWhisperResult,
} from "./jev.js";
import {
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "../shared/protocol.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeJevEvaluator implements JevEvaluator {
  judgeCalls: JudgeMessageInput[] = [];
  whisperCalls: PickInterceptedWhisperInput[] = [];
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
    this.whisperCalls.push(input);
    return {
      roundId: input.roundId,
      whisperId: input.candidates[0]?.id ?? "",
    };
  }
}

class FakeJevRoomHarness {
  now = 1_700_000_000_000;
  alarmAt: number | null = null;
  storedState: string | null = null;
  closedConnections = new Set<string>();
  sentByConnection = new Map<string, ServerMessage[]>();
  rawBroadcasts: string[] = [];
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
        this.rawBroadcasts.push(payload);
        const parsed = ServerMessageSchema.parse(JSON.parse(payload));
        const list = this.sentByConnection.get(connectionId) ?? [];
        list.push(parsed);
        this.sentByConnection.set(connectionId, list);
      },
      broadcast: (payload, excludeConnectionIds = []) => {
        this.rawBroadcasts.push(payload);
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
      roomCode: "JEVR",
      transport,
      storage,
      clock: () => this.now,
      generateId: () => `id-${++this.idCounter}`,
      random,
      jevEvaluator: this.jev,
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

  advanceTime(ms: number): void {
    this.now += ms;
    if (this.alarmAt !== null && this.now >= this.alarmAt) {
      this.alarmAt = null;
      this.room.onAlarm();
    }
  }

  async flushJev(): Promise<void> {
    await this.room.flushPendingEvaluations();
  }

  messagesFor(connectionId: string): ServerMessage[] {
    return this.sentByConnection.get(connectionId) ?? [];
  }

  clearMessages(): void {
    this.rawBroadcasts = [];
    for (const [k] of this.sentByConnection) {
      this.sentByConnection.set(k, []);
    }
  }
}

function setup3PlayerMatch(h: FakeJevRoomHarness): string[] {
  h.send("c1", { type: "join", name: "Alice" });
  h.send("c2", { type: "join", name: "Bob" });
  h.send("c3", { type: "join", name: "Carol" });
  const ids = ["c1", "c2", "c3"].map((cid) => {
    const snap = h.messagesFor(cid).find((m) => m.type === "room_snapshot");
    if (snap?.type !== "room_snapshot") throw new Error("expected snapshot");
    return snap.selfPlayerId;
  });
  h.send("c1", { type: "start_match" });
  return ids;
}

describe("RoomCore Jev, Entity Moods, Doom math & tiebreakers (#18)", () => {
  it("rotates across Entity Moods every 30s during ROUND_ACTIVE without repeats and never leaks entityMood in ServerMessage", async () => {
    // 3 players -> ROUND_ACTIVE is 55_000ms (so 1 rotation at 30_000ms)
    const h = new FakeJevRoomHarness([0.0, 0.0, 0.2, 0.4, 0.6, 0.8]);
    setup3PlayerMatch(h);
    h.advanceTime(3500); // -> ROUND_ACTIVE (55s)

    h.send("c1", { type: "send_chat", text: "Please spare me, I beg you." });
    await h.flushJev();

    const mood1 = h.jev.judgeCalls[0]?.entityMood;
    expect(ENTITY_MOODS).toContain(mood1);
    expect(h.jev.judgeCalls[0]?.moodRubric.length).toBeGreaterThan(10);

    // Advance 30s -> should rotate to a strictly different Mood and emit MOOD_SHIFT hint
    h.clearMessages();
    h.advanceTime(30_000);

    const announcements = h
      .messagesFor("c1")
      .filter((m) => m.type === "entity_announcement");
    expect(announcements.some((a) => a.beatType === "MOOD_SHIFT")).toBe(true);

    h.send("c2", { type: "send_chat", text: "Alice is lying to you!" });
    await h.flushJev();

    const mood2 = h.jev.judgeCalls[1]?.entityMood;
    expect(ENTITY_MOODS).toContain(mood2);
    expect(mood2).not.toBe(mood1);

    // Verify entityMood and raw mood names never appear in any ServerMessage payload
    for (const raw of h.rawBroadcasts) {
      expect(raw).not.toContain("entityMood");
      for (const m of ENTITY_MOODS) {
        expect(raw).not.toContain(m);
      }
    }
  });

  it("passes living players (excluding Ghosts) & last 6 messages to Jev, and applies uniform Doom math & spam mockery throttling", async () => {
    const h = new FakeJevRoomHarness();
    const [aliceId, bobId, carolId] = setup3PlayerMatch(h);
    h.advanceTime(3500); // Round 1 ROUND_ACTIVE

    // 1. Strong plea blaming Bob: score 3.4 -> speaker round((2.0-3.4)*6) = -8, Bob round((3.4-2.0)*5) = +7
    h.jev.onJudge(async (input) => ({
      roundId: input.roundId,
      persuasivenessScore: 3.4,
      targetBlamed: bobId!,
      targetBlamedConfidence: 0.75,
      isLowEffortSpamNoul: 0.05,
    }));

    h.clearMessages();
    h.send("c1", { type: "send_chat", text: "Bob was whispering behind your back!" });
    await h.flushJev();

    const doomUpd1 = h.messagesFor("c1").find((m) => m.type === "doom_updated");
    expect(doomUpd1).toMatchObject({
      type: "doom_updated",
      updates: expect.arrayContaining([
        { playerId: aliceId, doom: 42, delta: -8 },
        { playerId: bobId, doom: 57, delta: 7 },
      ]),
    });

    // 2. Weak plea with SELF blame: score 1.0 -> +6, plus SELF blame (conf 0.6) -> +8 => total +14 (57 + 14 = 71)
    h.jev.onJudge(async (input) => ({
      roundId: input.roundId,
      persuasivenessScore: 1.0,
      targetBlamed: "SELF",
      targetBlamedConfidence: 0.6,
      isLowEffortSpamNoul: 0.1,
    }));

    h.clearMessages();
    h.send("c2", { type: "send_chat", text: "I deserve whatever you do to me." });
    await h.flushJev();

    const doomUpd2 = h.messagesFor("c1").find((m) => m.type === "doom_updated");
    expect(doomUpd2).toMatchObject({
      type: "doom_updated",
      updates: [{ playerId: bobId, doom: 71, delta: 14 }],
    });

    // 3. Low-effort spam (noul >= 0.7): skips persuasiveness/blame, flat +8%, throttled mockery (<=1 per 5s)
    h.jev.onJudge(async (input) => ({
      roundId: input.roundId,
      persuasivenessScore: 4.0, // would be -12 if not skipped
      targetBlamed: aliceId!,
      targetBlamedConfidence: 0.99,
      isLowEffortSpamNoul: 0.7,
    }));

    h.clearMessages();
    h.send("c3", { type: "send_chat", text: "asdfasdf" });
    await h.flushJev();

    const doomUpd3 = h.messagesFor("c1").find((m) => m.type === "doom_updated");
    expect(doomUpd3).toMatchObject({
      type: "doom_updated",
      updates: [{ playerId: carolId, doom: 58, delta: 8 }],
    });
    expect(
      h.messagesFor("c1").filter(
        (m) => m.type === "entity_announcement" && m.beatType === "SPAM_MOCKERY",
      ),
    ).toHaveLength(1);

    // Another spam within 5s (at +2.5s) -> +8% Doom, NO second mockery
    h.advanceTime(2500);
    h.clearMessages();
    h.send("c3", { type: "send_chat", text: "qqqqqq" });
    await h.flushJev();

    expect(
      h.messagesFor("c1").filter(
        (m) => m.type === "entity_announcement" && m.beatType === "SPAM_MOCKERY",
      ),
    ).toHaveLength(0);

    // Spam after 5s -> emits mockery again
    h.advanceTime(3000);
    h.clearMessages();
    h.send("c3", { type: "send_chat", text: "zzzzzz" });
    await h.flushJev();

    expect(
      h.messagesFor("c1").filter(
        (m) => m.type === "entity_announcement" && m.beatType === "SPAM_MOCKERY",
      ),
    ).toHaveLength(1);

    // Send 3 more messages so we have > 6 messages in the round, then check recentMessages cap (6)
    h.jev.onJudge(async (input) => ({
      roundId: input.roundId,
      persuasivenessScore: 2.0,
      targetBlamed: "NONE",
      targetBlamedConfidence: 0.9,
      isLowEffortSpamNoul: 0.0,
    }));
    h.advanceTime(3000);
    h.send("c1", { type: "send_chat", text: "Message A" });
    h.send("c2", { type: "send_chat", text: "Message B" });
    h.send("c3", { type: "send_chat", text: "Message C" });
    h.advanceTime(3000);
    h.send("c1", { type: "send_chat", text: "Message D" });
    await h.flushJev();

    const lastCall = h.jev.judgeCalls[h.jev.judgeCalls.length - 1]!;
    expect(lastCall.recentMessages).toHaveLength(6);
    expect(lastCall.recentMessages[5]?.text).toBe("Message C");

    // Eliminate Carol -> Round 2 -> verify Ghost Carol is excluded from livingPlayers
    h.room.setPlayerDoomForMatch(carolId!, 99);
    h.advanceTime(55_000 - 11_500); // finish ROUND_ACTIVE
    h.advanceTime(3_000); // ROUND_RESOLVING -> SACRIFICE_REVEAL
    h.advanceTime(4_500); // -> Round 2 ROUND_INTRO
    h.advanceTime(3_500); // -> Round 2 ROUND_ACTIVE

    h.send("c1", { type: "send_chat", text: "Only two of us remain." });
    await h.flushJev();
    const round2Call = h.jev.judgeCalls[h.jev.judgeCalls.length - 1]!;
    expect(round2Call.livingPlayers.map((p) => p.id)).not.toContain(carolId);
    expect(round2Call.livingPlayers).toHaveLength(2);
  });

  it("applies verdicts in arrival order, discards stale roundId / post-3s-cap verdicts, and immediately sacrifices at 100% mid-round", async () => {
    const h = new FakeJevRoomHarness();
    const [aliceId, bobId, carolId] = setup3PlayerMatch(h);
    h.advanceTime(3500); // Round 1 ROUND_ACTIVE

    // Queue two deferred verdicts: Bob's finishes first, Alice's is held across round end
    const aliceDeferred = createDeferred<JudgeMessageResult>();
    const bobDeferred = createDeferred<JudgeMessageResult>();
    let callCount = 0;
    h.jev.onJudge(async (input) => {
      callCount += 1;
      return callCount === 1 ? aliceDeferred.promise : bobDeferred.promise;
    });

    h.send("c1", { type: "send_chat", text: "First message" });
    h.send("c2", { type: "send_chat", text: "Second message" });

    // Bob's verdict arrives first -> applies immediately
    h.clearMessages();
    bobDeferred.resolve({
      roundId: h.jev.judgeCalls[1]!.roundId,
      persuasivenessScore: 0.0, // +12% -> Bob at 62%
      targetBlamed: "NONE",
      targetBlamedConfidence: 0.9,
      isLowEffortSpamNoul: 0.0,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(h.messagesFor("c1").find((m) => m.type === "doom_updated")).toMatchObject({
      type: "doom_updated",
      updates: [{ playerId: bobId, doom: 62, delta: 12 }],
    });

    // Bring Bob to 95%, then Carol sends a message that pushes Bob to 100% mid-round
    h.room.setPlayerDoomForMatch(bobId!, 95);
    const carolDeferred = createDeferred<JudgeMessageResult>();
    h.jev.onJudge(async () => carolDeferred.promise);
    h.send("c3", { type: "send_chat", text: "Bob is the traitor!" });

    h.clearMessages();
    carolDeferred.resolve({
      roundId: h.jev.judgeCalls[2]!.roundId,
      persuasivenessScore: 4.0, // Carol -12%, Bob +10% -> Bob hits 100%!
      targetBlamed: bobId!,
      targetBlamedConfidence: 0.95,
      isLowEffortSpamNoul: 0.0,
    });
    await new Promise((r) => setTimeout(r, 0));

    // Immediate SACRIFICE_REVEAL claiming Bob!
    const reveal = h.messagesFor("c1").find((m) => m.type === "phase_changed");
    expect(reveal).toMatchObject({
      type: "phase_changed",
      phase: "IN_MATCH",
      matchPhase: "SACRIFICE_REVEAL",
      sacrificedPlayerId: bobId,
    });

    // Alice's still-in-flight verdict from Round 1 resolves AFTER mid-round sacrifice -> MUST be discarded
    h.clearMessages();
    aliceDeferred.resolve({
      roundId: h.jev.judgeCalls[0]!.roundId,
      persuasivenessScore: 0.0,
      targetBlamed: carolId!,
      targetBlamedConfidence: 0.9,
      isLowEffortSpamNoul: 0.0,
    });
    await h.flushJev();

    expect(h.messagesFor("c1").find((m) => m.type === "doom_updated")).toBeUndefined();

    // Advance to Round 2 -> test ROUND_RESOLVING 3s cap discarding late verdict
    h.advanceTime(4500); // -> Round 2 ROUND_INTRO
    h.advanceTime(3500); // -> Round 2 ROUND_ACTIVE (45s for 2p remaining of 3p)

    const lateDeferred = createDeferred<JudgeMessageResult>();
    h.jev.onJudge(async () => lateDeferred.promise);
    h.send("c1", { type: "send_chat", text: "Late plea in round 2" });

    // Expire ROUND_ACTIVE -> enters ROUND_RESOLVING with 3s cap
    h.advanceTime(45_000);
    // Advance 3_000ms -> SACRIFICE_REVEAL (past 3s cap)
    h.advanceTime(3_000);
    // Even if we check a verdict tagged with stale roundId or past 3s cap, it's discarded
    h.clearMessages();
    lateDeferred.resolve({
      roundId: h.jev.judgeCalls[3]!.roundId,
      persuasivenessScore: 0.0,
      targetBlamed: "NONE",
      targetBlamedConfidence: 0.9,
      isLowEffortSpamNoul: 0.0,
    });
    await h.flushJev();
    expect(h.messagesFor("c1").find((m) => m.type === "doom_updated")).toBeUndefined();
    expect(aliceId).toBeTruthy();
  });

  it("triggers 30s sudden-death on 0:00 tie (holding one Mood) and breaks second tie via longest silent -> random", async () => {
    const h = new FakeJevRoomHarness([0.2, 0.4, 0.6]);
    const [aliceId, bobId, carolId] = setup3PlayerMatch(h);
    h.advanceTime(3500); // Round 1 ROUND_ACTIVE (55s)

    // All three players tied at 50% at 0:00, Alice & Bob spoke, Carol never spoke (longest silent)
    h.send("c1", { type: "send_chat", text: "Alice speaks first." });
    h.advanceTime(1000);
    h.send("c2", { type: "send_chat", text: "Bob speaks second." });
    await h.flushJev();

    // Reset all to 60% so all 3 tie at 0:00
    h.room.setPlayerDoomForMatch(aliceId!, 60);
    h.room.setPlayerDoomForMatch(bobId!, 60);
    h.room.setPlayerDoomForMatch(carolId!, 60);

    h.advanceTime(54_000); // -> ROUND_RESOLVING
    h.clearMessages();
    h.advanceTime(2_000); // -> Sudden Death ROUND_ACTIVE (30s)

    const sdPhase = h.messagesFor("c1").find((m) => m.type === "phase_changed");
    expect(sdPhase).toMatchObject({
      type: "phase_changed",
      phase: "IN_MATCH",
      matchPhase: "ROUND_ACTIVE",
      phaseEndsAt: h.now + 30_000,
    });
    expect(
      h.messagesFor("c1").find(
        (m) => m.type === "entity_announcement" && m.beatType === "SUDDEN_DEATH",
      ),
    ).toBeDefined();

    // Sudden death expires at 30_000ms with all 3 still tied at 60% -> ROUND_RESOLVING -> breaks via longest silent (Carol)
    h.advanceTime(30_000);
    h.clearMessages();
    h.advanceTime(2_000);

    const reveal = h.messagesFor("c1").find((m) => m.type === "phase_changed");
    expect(reveal).toMatchObject({
      type: "phase_changed",
      matchPhase: "SACRIFICE_REVEAL",
      sacrificedPlayerId: carolId,
    });
  });

  it("triggers 30s sudden-death with 95% clamp on simultaneous 100% spike", async () => {
    const h = new FakeJevRoomHarness();
    const [aliceId, bobId] = setup3PlayerMatch(h);
    h.advanceTime(3500);

    // Put both Alice and Bob at 95%
    h.room.setPlayerDoomForMatch(aliceId!, 95);
    h.room.setPlayerDoomForMatch(bobId!, 95);

    // Alice sends a bad plea blaming Bob with score > 2.0? Wait: score 2.5 gives Alice -3 and Bob +3.
    // Instead: Alice is at 95%, Bob is at 95%. Alice gets +8% (spam) or self-blame?
    // Or Alice is at 96% and Bob is at 98%: score 2.5 -> Alice -3 (93), Bob +3 (100).
    // Simultaneous 100% can happen when speaker is at 90% (self-blame? no, blaming Bob) ->
    // Wait: if speaker is at 95% and score = 1.0 (+6 -> 100), other-blame requires score > 2.0.
    // Wait: what if Alice is at 95% and Carol is at 95%, and Alice's score is 2.1 (-1, +1) -> no.
    // What if Alice is at 99% and score is 2.1? -1 -> 98.
    // Wait: how can 2 players hit 100% from one verdict? If speaker has 100% already? No, if speaker is at 100% they'd already be sacrificed.
    // Actually: if Bob was at 95% and Carol was at 100% (set via setPlayerDoomForMatch or two verdicts? No, one verdict only updates speaker + 1 blamed player).
    // Speaker delta is round((2.0 - score) * 6). Other-player blame is round((score - 2.0) * 5) when score > 2.0.
    // Notice when score > 2.0, speaker delta is <= 0! So in a single verdict without Curses, speaker and blamed player move in opposite directions.
    // With Curses (#21), speaker can fail a Curse (+12%) while blaming another player (+10%)!
    // For #18 test, we can set Bob to 100% and Alice to 95%, or verify via setPlayerDoomForMatch(bobId, 100) + Alice hitting 100% on verdict!
    h.room.setPlayerDoomForMatch(bobId!, 100);
    h.jev.onJudge(async (input) => ({
      roundId: input.roundId,
      persuasivenessScore: 0.0, // +12% -> Alice hits 100% too!
      targetBlamed: "NONE",
      targetBlamedConfidence: 0.9,
      isLowEffortSpamNoul: 0.0,
    }));

    h.clearMessages();
    h.send("c1", { type: "send_chat", text: "We both burn!" });
    await h.flushJev();

    const sdPhase = h.messagesFor("c1").find((m) => m.type === "phase_changed");
    expect(sdPhase).toMatchObject({
      type: "phase_changed",
      phase: "IN_MATCH",
      matchPhase: "ROUND_ACTIVE",
      phaseEndsAt: h.now + 30_000,
    });
    if (sdPhase?.type !== "phase_changed") throw new Error("expected phase_changed");
    expect(sdPhase.players.find((p) => p.id === aliceId)?.doom).toBe(95);
    expect(sdPhase.players.find((p) => p.id === bobId)?.doom).toBe(95);
  });

  it("fails closed to POST_MATCH with JUDGE_ERROR and safe banner on persistent Jev error", async () => {
    const h = new FakeJevRoomHarness();
    setup3PlayerMatch(h);
    h.advanceTime(3500);

    h.jev.onJudge(async () => {
      throw new Error("TypeSafe API 503 Service Unavailable: secret-key-leak");
    });

    h.clearMessages();
    h.send("c1", { type: "send_chat", text: "Please hear my plea!" });
    await h.flushJev();

    const ended = h.messagesFor("c1").find((m) => m.type === "phase_changed");
    expect(ended).toMatchObject({
      type: "phase_changed",
      phase: "POST_MATCH",
      matchPhase: null,
      winnerId: null,
      endReason: "JUDGE_ERROR",
      phaseEndsAt: null,
    });

    const banner = h.messagesFor("c1").find(
      (m) => m.type === "entity_announcement" && m.beatType === "POST_MATCH_JUDGE_ERROR",
    );
    expect(banner).toMatchObject({
      type: "entity_announcement",
      text: "The Entity fell silent — Match aborted",
    });

    for (const raw of h.rawBroadcasts) {
      expect(raw).not.toContain("503");
      expect(raw).not.toContain("secret-key-leak");
    }
  });
});
