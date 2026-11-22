import { describe, it, expect } from "vitest";
import { createJsonLogger } from "./logger.js";
import { TypeSafeJevEvaluator } from "./jev.js";
import { RoomCore, type RoomStorage, type RoomTransport } from "./room-core.js";
import { ROOM_EMPTY_CLEANUP_MS, ROUND_INTRO_MS, getRoundDurationMs } from "../shared/constants.js";

describe("createJsonLogger", () => {
  it("emits single-line structured JSON with timestamp, level, event, and safe fields", () => {
    const lines: string[] = [];
    const logger = createJsonLogger({
      sink: (line) => lines.push(line),
      now: () => "2026-11-22T12:00:00.000Z",
    });

    logger.info("match_started", {
      roomCode: "ABCD",
      playerCount: 4,
      totalRounds: 3,
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toEqual({
      timestamp: "2026-11-22T12:00:00.000Z",
      level: "info",
      event: "match_started",
      roomCode: "ABCD",
      playerCount: 4,
      totalRounds: 3,
    });
  });

  it("strips sensitive keys such as chat text, whisper text, curse words, playerTokens, and secrets", () => {
    const lines: string[] = [];
    const logger = createJsonLogger({
      sink: (line) => lines.push(line),
      now: () => "2026-11-22T12:00:00.000Z",
    });

    logger.warn("player_disconnected", {
      roomCode: "WXYZ",
      playerId: "p1",
      playerToken: "secret-player-token-123",
      apiKey: "ts-live-secret-key",
      TYPESAFE_API_KEY: "ts-live-secret-key-2",
      text: "Please spare me Entity!",
      messageText: "Another raw plea",
      playerMessage: "Raw plea 2",
      whisperText: "Betray Alice",
      curseWord: "blood",
      activeCurses: ["blood", "shadow"],
      nested: {
        token: "nested-token",
        safeCount: 2,
      },
    });

    expect(lines).toHaveLength(1);
    const raw = lines[0]!;
    expect(raw).not.toContain("secret-player-token-123");
    expect(raw).not.toContain("ts-live-secret-key");
    expect(raw).not.toContain("Please spare me Entity!");
    expect(raw).not.toContain("Another raw plea");
    expect(raw).not.toContain("Raw plea 2");
    expect(raw).not.toContain("Betray Alice");
    expect(raw).not.toContain("blood");
    expect(raw).not.toContain("shadow");
    expect(raw).not.toContain("nested-token");

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.roomCode).toBe("WXYZ");
    expect(parsed.playerId).toBe("p1");
    expect(parsed.nested).toEqual({ safeCount: 2 });
  });
});

describe("TypeSafeJevEvaluator structured logging", () => {
  it("logs Jev call latency on success and error code on failure without leaking chat, curses, whispers, or API key", async () => {
    const lines: string[] = [];
    const logger = createJsonLogger({
      sink: (line) => lines.push(line),
      now: () => "2026-11-22T12:00:00.000Z",
    });

    let clockMs = 1000;
    const evaluator = new TypeSafeJevEvaluator("ts-super-secret-api-key", {
      logger,
      clock: () => clockMs,
      client: {
        systemOne: async () => {
          clockMs += 145;
          return {
            answers: {
              persuasiveness: { score: 3 },
              targetBlamed: { choice: "NONE", confidence: 0.9 },
              isLowEffortSpam: { noul: 0.1 },
              curse_0: { noul: 0.8 },
            },
          };
        },
      },
    });

    await evaluator.judgeMessage({
      roundId: "round-1",
      entityMood: "SADIST",
      moodRubric: "Be cruel",
      livingPlayers: [{ id: "p1", name: "Alice", doom: 20 }],
      recentMessages: [{ speakerName: "Bob", text: "Bob secret plea text" }],
      speaker: { id: "p1", name: "Alice" },
      messageText: "Alice raw chat plea with ember",
      activeCurses: ["ember"],
    });

    const failingEvaluator = new TypeSafeJevEvaluator("ts-super-secret-api-key", {
      logger,
      clock: () => clockMs,
      client: {
        systemOne: async () => {
          clockMs += 320;
          const err = new Error(
            "Request failed with apiKey=ts-super-secret-api-key for Whisper text",
          ) as Error & { code?: string; status?: number };
          err.name = "TypeSafeTimeoutError";
          err.code = "ETIMEDOUT";
          err.status = 504;
          throw err;
        },
      },
    });

    await expect(
      failingEvaluator.pickInterceptedWhisper({
        roundId: "round-2",
        entityMood: "PARANOID",
        candidates: [
          {
            id: "w1",
            senderName: "Alice",
            targetName: "Bob",
            text: "Secret whisper betrayal text",
          },
          {
            id: "w2",
            senderName: "Bob",
            targetName: "Alice",
            text: "Another secret whisper",
          },
        ],
      }),
    ).rejects.toThrow();

    expect(lines).toHaveLength(2);
    const allLogs = lines.join("\n");
    expect(allLogs).not.toContain("ts-super-secret-api-key");
    expect(allLogs).not.toContain("Alice raw chat plea");
    expect(allLogs).not.toContain("Bob secret plea text");
    expect(allLogs).not.toContain("ember");
    expect(allLogs).not.toContain("Secret whisper betrayal text");
    expect(allLogs).not.toContain("Another secret whisper");

    const okLog = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(okLog.event).toBe("jev_call_completed");
    expect(okLog.operation).toBe("judgeMessage");
    expect(okLog.roundId).toBe("round-1");
    expect(okLog.latencyMs).toBe(145);

    const errLog = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(errLog.level).toBe("error");
    expect(errLog.event).toBe("jev_call_failed");
    expect(errLog.operation).toBe("pickInterceptedWhisper");
    expect(errLog.roundId).toBe("round-2");
    expect(errLog.latencyMs).toBe(320);
    expect(errLog.errorName).toBe("TypeSafeTimeoutError");
    expect(errLog.errorCode).toBe("ETIMEDOUT");
  });
});

describe("RoomCore structured lifecycle logging", () => {
  it("logs room_created, match_started, player_disconnected, match_ended, and room_cleaned_up without leaking chat or tokens", async () => {
    const lines: string[] = [];
    let now = 1_700_000_000_000;
    const logger = createJsonLogger({
      sink: (line) => lines.push(line),
      now: () => new Date(now).toISOString(),
    });

    let storedState: string | null = null;
    const transport: RoomTransport = {
      send: () => {},
      broadcast: () => {},
      close: () => {},
    };
    const storage: RoomStorage = {
      load: () => storedState,
      save: (s) => {
        storedState = s;
      },
      scheduleAlarm: () => {},
      deleteAll: () => {
        storedState = null;
      },
    };

    const jev = new TypeSafeJevEvaluator("ts-room-secret-key", {
      logger,
      clock: () => now,
      client: {
        systemOne: async () => ({
          answers: {
            persuasiveness: { score: 0 },
            targetBlamed: { choice: "NONE", confidence: 0.9 },
            isLowEffortSpam: { noul: 0.1 },
          },
        }),
      },
    });

    const core = new RoomCore({
      roomCode: "DEAD",
      transport,
      storage,
      clock: () => now,
      random: () => 0.2,
      jevEvaluator: jev,
      logger,
    });

    // Two players join with secret tokens
    core.onMessage(
      "c1",
      JSON.stringify({
        type: "join",
        name: "Alice",
        playerToken: "alice-secret-token-xyz",
      }),
    );
    core.onMessage(
      "c2",
      JSON.stringify({
        type: "join",
        name: "Bob",
        playerToken: "bob-secret-token-xyz",
      }),
    );

    // Host starts Match
    core.onMessage("c1", JSON.stringify({ type: "start_match" }));
    now += ROUND_INTRO_MS;
    core.onAlarm();

    // Alice sends a public plea containing sensitive text
    core.onMessage(
      "c1",
      JSON.stringify({
        type: "send_chat",
        text: "MY_PRIVATE_PLEA_NEVER_LOG_THIS",
      }),
    );
    await core.flushPendingEvaluations();

    // Bob disconnects during Match
    core.onClose("c2");

    // Advance past round duration + resolving to end or forfeit
    now += getRoundDurationMs(2, 2) + 5_000;
    core.onAlarm();

    // Alice leaves to make room empty, then trigger empty cleanup alarm
    core.onClose("c1");
    now += ROOM_EMPTY_CLEANUP_MS + 1;
    core.onAlarm();

    const parsed = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    const events = parsed.map((entry) => entry.event);

    expect(events).toContain("room_created");
    expect(events).toContain("match_started");
    expect(events).toContain("player_disconnected");
    expect(events).toContain("match_ended");
    expect(events).toContain("room_cleaned_up");

    const allLogs = lines.join("\n");
    expect(allLogs).not.toContain("MY_PRIVATE_PLEA_NEVER_LOG_THIS");
    expect(allLogs).not.toContain("alice-secret-token-xyz");
    expect(allLogs).not.toContain("bob-secret-token-xyz");
    expect(allLogs).not.toContain("ts-room-secret-key");
  });
});
