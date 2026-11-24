import {
  CHAT_COOLDOWN_MS,
  CLOSEST_CALL_DOOM_THRESHOLD,
  CURSE_COOLDOWN_MS,
  CURSE_FAIL_DOOM_PENALTY,
  IN_MATCH_DISCONNECT_GRACE_MS,
  INITIAL_DOOM,
  MAX_CHAT_LENGTH,
  MAX_FEED_ITEMS,
  MAX_PLAYERS,
  MAX_WHISPER_LENGTH,
  MIN_CHAT_LENGTH,
  MIN_PLAYERS,
  MIN_PLAYERS_FOR_WHISPERS,
  MIN_WHISPER_LENGTH,
  PRESET_AVATARS,
  RECENT_CONTEXT_LIMIT,
  ROOM_EMPTY_CLEANUP_MS,
  ROOM_IDLE_CLEANUP_MS,
  ROUND_INTRO_MS,
  ROUND_RESOLVING_MAX_MS,
  ROUND_RESOLVING_MS,
  SACRIFICE_REVEAL_MS,
  SPAM_MOCKERY_COOLDOWN_MS,
  SUDDEN_DEATH_CLAMP_DOOM,
  SUDDEN_DEATH_DURATION_MS,
  WAITING_DISCONNECT_GRACE_MS,
  WHISPER_COOLDOWN_MS,
  WHISPER_INTERCEPT_BATCH_SIZE,
  WHISPER_INTERCEPT_CANDIDATE_LIMIT,
  WHISPER_INTERCEPT_DOOM_PENALTY,
  WHISPER_INTERCEPT_FALLBACK_REMAINING_MS,
  WHISPER_INTERCEPT_MIN_GAP_MS,
  getRoundDurationMs,
  isValidCurseWord,
  softResetDoom,
  type PresetAvatarId,
} from "../shared/constants.js";
import {
  MOOD_RUBRICS,
  pickNextMood,
  type EntityMood,
  type JevEvaluator,
  type JudgeMessageResult,
} from "./jev.js";
import {
  EntityCopyEngine,
  type SerializedCopyEngineState,
} from "./copy/copy-engine.js";
import { POST_MATCH_JUDGE_ERROR } from "./copy/script-bank.js";
import {
  ClientMessageSchema,
  type ActiveCurse,
  type ClientMessage,
  type CurseResolutionItem,
  type EliminationCause,
  type EliminationEvent,
  type ErrorCode,
  type FeedItem,
  type MatchEndReason,
  type MatchPhase,
  type PostMatchAward,
  type PostMatchSummary,
  type PublicPlayer,
  type RoomPhase,
  type ServerMessage,
} from "../shared/protocol.js";
import { NOOP_LOGGER, type Logger } from "./logger.js";

export interface RoomTransport {
  send(connectionId: string, payload: string): void;
  broadcast(payload: string, excludeConnectionIds?: string[]): void;
  close(connectionId: string, code?: number, reason?: string): void;
  onAttachPlayer?(connectionId: string, playerId: string): void;
}

export interface RoomStorage {
  load(): string | null;
  save(stateJson: string): void;
  scheduleAlarm(atEpochMs: number | null): void;
  deleteAll(): void;
}

export interface RoomCoreOptions {
  roomCode: string;
  transport: RoomTransport;
  storage: RoomStorage;
  clock?: () => number;
  generateId?: () => string;
  random?: () => number;
  jevEvaluator?: JevEvaluator;
  logger?: Logger;
}

interface InternalPlayer {
  id: string;
  playerToken: string;
  name: string;
  avatarId: PresetAvatarId;
  isHost: boolean;
  connected: boolean;
  joinedAt: number;
  alive: boolean;
  doom: number;
  disconnectGraceEndsAt: number | null;
  lastChatAt: number | null;
  lastWhisperAt: number | null;
  leakedWhisperCount: number;
  lastCurseAt: number | null;
  cursesReceived: number;
  cursesFailed: number;
  cursesPassed: number;
  roundPeakDoom: number;
  peakSurvivedDoom: number;
}

interface RoundWhisper {
  id: string;
  senderId: string;
  senderName: string;
  targetId: string;
  targetName: string;
  text: string;
  timestamp: number;
  leaked: boolean;
}

export interface LeakedWhisperSummary {
  whisperId: string;
  senderId: string;
  senderName: string;
  targetId: string;
  targetName: string;
  text: string;
  round: number;
  timestamp: number;
}

interface PersistedRoomState {
  phase: RoomPhase;
  matchPhase: MatchPhase | null;
  round: number;
  totalRounds: number;
  initialPlayerCount: number;
  phaseEndsAt: number | null;
  sacrificedPlayerId: string | null;
  winnerId: string | null;
  endReason: MatchEndReason | null;
  feed: FeedItem[];
  players: InternalPlayer[];
  activeCurses?: ActiveCurse[];
  entityMood?: EntityMood;
  previousRoundMood?: EntityMood | null;
  copyState?: SerializedCopyEngineState;
  roundId?: string;
  isSuddenDeath?: boolean;
  roundPublicMessages?: Array<{ speakerName: string; text: string }>;
  lastSpamMockeryAt?: number | null;
  resolvingCapAt?: number | null;
  emptySince?: number | null;
  lastActivityAt?: number | null;
  roundWhispers?: RoundWhisper[];
  lastWhisperInterceptAt?: number | null;
  roundWhisperInterceptCount?: number;
  whisperFallbackTriggered?: boolean;
  whisperFallbackAt?: number | null;
  lastLeakedWhisper?: LeakedWhisperSummary | null;
  eliminations?: EliminationEvent[];
  postMatchClosingBeat?: string | null;
}

export class RoomCore {
  private readonly roomCode: string;
  private readonly transport: RoomTransport;
  private readonly storage: RoomStorage;
  private readonly clock: () => number;
  private readonly generateId: () => string;
  private readonly random: () => number;
  private readonly jevEvaluator?: JevEvaluator;
  private readonly logger: Logger;

  private phase: RoomPhase = "WAITING";
  private matchPhase: MatchPhase | null = null;
  private round = 0;
  private totalRounds = 0;
  private initialPlayerCount = 0;
  private phaseEndsAt: number | null = null;
  private sacrificedPlayerId: string | null = null;
  private winnerId: string | null = null;
  private endReason: MatchEndReason | null = null;
  private feed: FeedItem[] = [];
  private players: InternalPlayer[] = [];
  private activeCurses: ActiveCurse[] = [];
  private entityMood: EntityMood = "SADIST";
  private previousRoundMood: EntityMood | null = null;
  private copyEngine: EntityCopyEngine;
  private roundId = "";
  private isSuddenDeath = false;
  private roundPublicMessages: Array<{ speakerName: string; text: string }> = [];
  private lastSpamMockeryAt: number | null = null;
  private resolvingCapAt: number | null = null;
  private pendingEvaluations = new Set<Promise<void>>();
  private emptySince: number | null = null;
  private lastActivityAt: number | null = null;
  private roundWhispers: RoundWhisper[] = [];
  private lastWhisperInterceptAt: number | null = null;
  private roundWhisperInterceptCount = 0;
  private whisperFallbackTriggered = false;
  private whisperFallbackAt: number | null = null;
  private lastLeakedWhisper: LeakedWhisperSummary | null = null;
  private eliminations: EliminationEvent[] = [];
  private postMatchClosingBeat: string | null = null;
  private whisperInterceptInFlight = false;
  private connectionToPlayerId = new Map<string, string>();
  private playerIdToConnectionId = new Map<string, string>();

  constructor(options: RoomCoreOptions) {
    this.roomCode = options.roomCode;
    this.transport = options.transport;
    this.storage = options.storage;
    this.clock = options.clock ?? (() => Date.now());
    this.generateId = options.generateId ?? (() => crypto.randomUUID());
    this.random = options.random ?? (() => Math.random());
    this.jevEvaluator = options.jevEvaluator;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.copyEngine = new EntityCopyEngine(this.random);

    const raw = this.storage.load();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as PersistedRoomState;
        this.phase = parsed.phase;
        this.matchPhase = parsed.matchPhase ?? null;
        this.round = parsed.round ?? 0;
        this.totalRounds = parsed.totalRounds ?? 0;
        this.initialPlayerCount = parsed.initialPlayerCount ?? 0;
        this.phaseEndsAt = parsed.phaseEndsAt;
        this.sacrificedPlayerId = parsed.sacrificedPlayerId ?? null;
        this.winnerId = parsed.winnerId ?? null;
        this.endReason = parsed.endReason ?? null;
        this.feed = (parsed.feed ?? []).slice(-MAX_FEED_ITEMS);
        this.players = (parsed.players ?? []).map((p) => ({
          ...p,
          lastChatAt: p.lastChatAt ?? null,
          lastWhisperAt: p.lastWhisperAt ?? null,
          leakedWhisperCount: p.leakedWhisperCount ?? 0,
          lastCurseAt: p.lastCurseAt ?? null,
          cursesReceived: p.cursesReceived ?? 0,
          cursesFailed: p.cursesFailed ?? 0,
          cursesPassed: p.cursesPassed ?? 0,
          roundPeakDoom: p.roundPeakDoom ?? p.doom,
          peakSurvivedDoom: p.peakSurvivedDoom ?? 0,
        }));
        this.activeCurses = parsed.activeCurses ?? [];
        this.entityMood = parsed.entityMood ?? "SADIST";
        this.previousRoundMood = parsed.previousRoundMood ?? null;
        if (parsed.copyState) {
          this.copyEngine.restore(parsed.copyState);
        }
        this.roundId = parsed.roundId ?? "";
        this.isSuddenDeath = parsed.isSuddenDeath ?? false;
        this.roundPublicMessages = parsed.roundPublicMessages ?? [];
        this.lastSpamMockeryAt = parsed.lastSpamMockeryAt ?? null;
        this.resolvingCapAt = parsed.resolvingCapAt ?? null;
        this.emptySince = parsed.emptySince ?? null;
        this.lastActivityAt = parsed.lastActivityAt ?? null;
        this.roundWhispers = parsed.roundWhispers ?? [];
        this.lastWhisperInterceptAt = parsed.lastWhisperInterceptAt ?? null;
        this.roundWhisperInterceptCount = parsed.roundWhisperInterceptCount ?? 0;
        this.whisperFallbackTriggered =
          parsed.whisperFallbackTriggered ?? false;
        this.whisperFallbackAt = parsed.whisperFallbackAt ?? null;
        this.lastLeakedWhisper = parsed.lastLeakedWhisper ?? null;
        this.eliminations = parsed.eliminations ?? [];
        this.postMatchClosingBeat = parsed.postMatchClosingBeat ?? null;
      } catch {
        // Ignore corrupted persisted state and start fresh
      }
    } else {
      this.logger.info("room_created", {
        roomCode: this.roomCode,
      });
    }
  }

  /** Await all currently in-flight Jev evaluations (useful for deterministic tests). */
  async flushPendingEvaluations(): Promise<void> {
    while (this.pendingEvaluations.size > 0) {
      await Promise.all(Array.from(this.pendingEvaluations));
    }
  }

  /** Rehydrate an existing WebSocket connection mapping after DO hibernation wakeup */
  rehydrateConnection(connectionId: string, playerId: string): void {
    const exists = this.players.some((p) => p.id === playerId);
    if (!exists) return;
    this.connectionToPlayerId.set(connectionId, playerId);
    this.playerIdToConnectionId.set(playerId, connectionId);
  }

  /** Exposed for server-side tests or match-phase transitions in downstream tickets */
  setPhaseForMatch(phase: RoomPhase, phaseEndsAt: number | null = null): void {
    this.phase = phase;
    this.phaseEndsAt = phaseEndsAt;
    this.persist();
  }

  /** Exposed for server-side tests or Doom updates in downstream tickets */
  setPlayerDoomForMatch(playerId: string, doom: number): void {
    const player = this.players.find((p) => p.id === playerId);
    if (!player) return;
    player.doom = Math.max(0, Math.min(100, Math.round(doom)));
    if (player.alive) {
      player.roundPeakDoom = Math.max(player.roundPeakDoom, player.doom);
    }
    this.persist();
  }

  /** Per-player leaked Whisper stats for POST_MATCH awards (#24) */
  getWhisperStatsForMatch(): {
    leakedCountByPlayerId: Record<string, number>;
    lastLeakedWhisper: LeakedWhisperSummary | null;
  } {
    const leakedCountByPlayerId: Record<string, number> = {};
    for (const p of this.players) {
      leakedCountByPlayerId[p.id] = p.leakedWhisperCount;
    }
    return {
      leakedCountByPlayerId,
      lastLeakedWhisper: this.lastLeakedWhisper,
    };
  }

  onMessage(connectionId: string, rawMessage: string): void {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawMessage);
    } catch {
      this.sendError(connectionId, "INVALID_PAYLOAD", "Malformed JSON frame.");
      return;
    }

    const result = ClientMessageSchema.safeParse(parsedJson);
    if (!result.success) {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        "Invalid message payload.",
      );
      return;
    }

    const msg = result.data;
    this.lastActivityAt = this.clock();
    switch (msg.type) {
      case "join":
        this.handleJoin(connectionId, msg);
        return;
      case "swap_avatar":
        this.handleSwapAvatar(connectionId, msg.avatarId);
        return;
      case "kick_player":
        this.handleKickPlayer(connectionId, msg.targetPlayerId);
        return;
      case "start_match":
        this.handleStartMatch(connectionId);
        return;
      case "send_chat":
        this.handleSendChat(connectionId, msg.text);
        return;
      case "send_whisper":
        this.handleSendWhisper(connectionId, msg.targetPlayerId, msg.text);
        return;
      case "cast_curse":
        this.handleCastCurse(connectionId, msg.targetPlayerId, msg.word);
        return;
      case "play_again":
        this.handlePlayAgain(connectionId);
        return;
      case "leave_room":
        this.handleLeaveRoom(connectionId);
        return;
      default: {
        const exhaustive: never = msg;
        this.sendError(
          connectionId,
          "INVALID_PAYLOAD",
          `Unsupported action: ${String(exhaustive)}`,
        );
      }
    }
  }

  onClose(connectionId: string, fallbackPlayerId?: string): void {
    const playerId =
      this.connectionToPlayerId.get(connectionId) ?? fallbackPlayerId;
    if (!playerId) return;

    this.connectionToPlayerId.delete(connectionId);
    const activeConnId = this.playerIdToConnectionId.get(playerId);
    if (activeConnId === connectionId) {
      this.playerIdToConnectionId.delete(playerId);
    } else if (activeConnId !== undefined) {
      // Connection was already superseded by a reconnect
      return;
    }

    const player = this.players.find((p) => p.id === playerId);
    if (!player) return;

    const now = this.clock();
    player.connected = false;
    if (this.phase === "WAITING" || this.phase === "POST_MATCH") {
      player.disconnectGraceEndsAt = now + WAITING_DISCONNECT_GRACE_MS;
    } else if (this.phase === "IN_MATCH") {
      player.disconnectGraceEndsAt = player.alive
        ? now + IN_MATCH_DISCONNECT_GRACE_MS
        : null;
    }

    if (this.players.every((p) => !p.connected) && this.emptySince === null) {
      this.emptySince = now;
    }

    if (this.players.every((p) => !p.connected) && this.emptySince === null) {
      this.emptySince = this.clock();
    }

    this.persist();
    this.rescheduleAlarm();
    this.broadcastPlayers();
    this.logger.info("player_disconnected", {
      roomCode: this.roomCode,
      playerId: player.id,
      phase: this.phase,
      alive: player.alive,
    });
  }

  onAlarm(): void {
    const now = this.clock();
    let changed = false;

    const emptyExpired =
      this.emptySince !== null &&
      this.emptySince + ROOM_EMPTY_CLEANUP_MS <= now;
    const idleExpired =
      (this.phase === "WAITING" || this.phase === "POST_MATCH") &&
      this.lastActivityAt !== null &&
      this.lastActivityAt + ROOM_IDLE_CLEANUP_MS <= now;

    if (emptyExpired || idleExpired) {
      this.logger.info("room_cleaned_up", {
        roomCode: this.roomCode,
        reason: emptyExpired ? "empty_timeout" : "idle_timeout",
        phase: this.phase,
      });
      this.wipeRoom();
      return;
    }

    if (this.phase === "WAITING" || this.phase === "POST_MATCH") {
      const expired = this.players.filter(
        (p) =>
          !p.connected &&
          p.disconnectGraceEndsAt !== null &&
          p.disconnectGraceEndsAt <= now,
      );
      for (const p of expired) {
        this.removePlayer(p.id);
        changed = true;
      }
      if (changed) {
        this.persist();
        this.broadcastPlayers();
      }
    } else if (this.phase === "IN_MATCH") {
      const expired = this.players.filter(
        (p) =>
          !p.connected &&
          p.alive &&
          p.disconnectGraceEndsAt !== null &&
          p.disconnectGraceEndsAt <= now,
      );
      for (const p of expired) {
        p.doom = 100;
        p.alive = false;
        p.disconnectGraceEndsAt = null;
        this.recordElimination(p, "DISCONNECT");
        if (p.isHost) {
          this.transferHostFrom(p.id);
        }
        this.emitEntityAnnouncement(
          "SACRIFICE_DISCONNECT",
          this.copyEngine.drawBeat("SACRIFICE_DISCONNECT", { player: p.name }),
          now,
        );
        changed = true;
        const living = this.players.filter((pl) => pl.alive);
        if (living.length <= 1) {
          this.endMatch(living, now);
          break;
        }
      }
      if (changed && this.phase === "IN_MATCH") {
        this.persist();
        this.broadcastPlayers();
      }
      if (
        this.phase === "IN_MATCH" &&
        this.phaseEndsAt !== null &&
        now >= this.phaseEndsAt
      ) {
        this.advanceMatchPhase(now);
      } else if (
        this.phase === "IN_MATCH" &&
        this.matchPhase === "ROUND_ACTIVE"
      ) {
        let interceptedInFallback = false;
        if (
          !this.whisperFallbackTriggered &&
          this.whisperFallbackAt !== null &&
          now >= this.whisperFallbackAt
        ) {
          this.whisperFallbackTriggered = true;
          const unleaked = this.roundWhispers.filter((w) => !w.leaked);
          if (
            this.roundWhisperInterceptCount === 0 &&
            unleaked.length >= 1 &&
            unleaked.length < WHISPER_INTERCEPT_BATCH_SIZE
          ) {
            this.triggerWhisperInterception(unleaked);
            interceptedInFallback = true;
          } else {
            this.persist();
          }
        }
        if (!interceptedInFallback) {
          this.maybeTriggerBatchWhisperInterception(now);
        }
      }
    }

    this.rescheduleAlarm();
  }

  private advanceMatchPhase(now: number): void {
    if (this.matchPhase === "ROUND_INTRO") {
      const livingCount = this.players.filter((p) => p.alive).length;
      const durationMs = getRoundDurationMs(
        livingCount,
        this.initialPlayerCount,
      );
      this.matchPhase = "ROUND_ACTIVE";
      this.phaseEndsAt = now + durationMs;
      this.roundWhispers = [];
      this.lastWhisperInterceptAt = null;
      this.roundWhisperInterceptCount = 0;
      this.whisperFallbackTriggered = false;
      this.whisperFallbackAt =
        durationMs > WHISPER_INTERCEPT_FALLBACK_REMAINING_MS
          ? this.phaseEndsAt - WHISPER_INTERCEPT_FALLBACK_REMAINING_MS
          : null;
      this.persist();
      this.broadcastPhaseChanged(now);
      return;
    }

    if (this.matchPhase === "ROUND_ACTIVE") {
      this.matchPhase = "ROUND_RESOLVING";
      this.whisperFallbackAt = null;
      this.activeCurses = [];
      const resolvingMs =
        this.pendingEvaluations.size > 0
          ? ROUND_RESOLVING_MAX_MS
          : ROUND_RESOLVING_MS;
      this.phaseEndsAt = now + resolvingMs;
      this.resolvingCapAt = now + ROUND_RESOLVING_MAX_MS;
      const resolvingText = this.copyEngine.drawBeat("ROUND_RESOLVING");
      this.persist();
      this.broadcastPhaseChanged(now);
      this.emitEntityAnnouncement("ROUND_RESOLVING", resolvingText, now);
      return;
    }

    if (this.matchPhase === "ROUND_RESOLVING") {
      const living = this.players.filter((p) => p.alive);
      if (living.length === 0) {
        this.matchPhase = "SACRIFICE_REVEAL";
        this.phaseEndsAt = now + SACRIFICE_REVEAL_MS;
        this.persist();
        this.broadcastPhaseChanged(now);
        return;
      }

      const maxDoom = Math.max(...living.map((p) => p.doom));
      const tied = living.filter((p) => p.doom === maxDoom);
      if (tied.length === 1) {
        this.sacrificePlayer(tied[0]!, now, "TIMER");
      } else if (!this.isSuddenDeath) {
        this.triggerSuddenDeath(now);
      } else {
        const victim = this.breakTieLongestSilentThenRandom(tied);
        this.sacrificePlayer(victim, now, "TIEBREAK");
      }
      return;
    }

    if (this.matchPhase === "SACRIFICE_REVEAL") {
      const living = this.players.filter((p) => p.alive);
      if (living.length <= 1) {
        this.endMatch(living, now);
        return;
      }

      this.round += 1;
      this.sacrificedPlayerId = null;
      this.isSuddenDeath = false;
      this.roundId = this.generateId();
      this.roundPublicMessages = [];
      this.resolvingCapAt = null;
      this.entityMood = pickNextMood(this.previousRoundMood, this.random);
      this.previousRoundMood = this.entityMood;
      const introText = this.copyEngine.drawBeat("ROUND_INTRO_NEXT");
      const hint = this.copyEngine.drawMoodHint(this.entityMood);
      for (const p of living) {
        p.doom = softResetDoom(p.doom);
        p.roundPeakDoom = p.doom;
      }
      for (const p of this.players) {
        p.lastCurseAt = null;
      }
      this.activeCurses = [];
      this.matchPhase = "ROUND_INTRO";
      this.phaseEndsAt = now + ROUND_INTRO_MS;
      this.persist();
      this.broadcastPhaseChanged(now);
      this.emitEntityAnnouncement("ROUND_INTRO", introText, now);
      this.emitEntityAnnouncement("MOOD_HINT", hint, now);
    }
  }

  private handleJoin(
    connectionId: string,
    msg: Extract<ClientMessage, { type: "join" }>,
  ): void {
    if (msg.playerToken) {
      const existing = this.players.find(
        (p) => p.playerToken === msg.playerToken,
      );
      if (existing) {
        this.attachConnection(connectionId, existing);
        existing.connected = true;
        existing.disconnectGraceEndsAt = null;
        this.emptySince = null;
        this.persist();
        this.rescheduleAlarm();
        this.sendSnapshot(connectionId, existing);
        this.broadcastPlayers([connectionId]);
        return;
      }
    }

    if (this.phase !== "WAITING") {
      this.sendError(
        connectionId,
        "ROOM_LOCKED",
        "This Room is currently locked.",
      );
      return;
    }

    if (this.players.length >= MAX_PLAYERS) {
      this.sendError(connectionId, "ROOM_FULL", "This Room is full.");
      return;
    }

    if (!msg.name) {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        "Display name is required to join.",
      );
      return;
    }

    const normalizedName = msg.name.toLowerCase();
    const duplicateName = this.players.some(
      (p) => p.name.toLowerCase() === normalizedName,
    );
    if (duplicateName) {
      this.sendError(
        connectionId,
        "NAME_TAKEN",
        "That display name is already taken in this Room.",
      );
      return;
    }

    const avatarId = this.pickAvatarForJoin(msg.avatarId);
    const now = this.clock();
    const player: InternalPlayer = {
      id: this.generateId(),
      playerToken: this.generateId(),
      name: msg.name,
      avatarId,
      isHost: this.players.length === 0,
      connected: true,
      joinedAt: now,
      alive: true,
      doom: INITIAL_DOOM,
      disconnectGraceEndsAt: null,
      lastChatAt: null,
      lastWhisperAt: null,
      leakedWhisperCount: 0,
      lastCurseAt: null,
      cursesReceived: 0,
      cursesFailed: 0,
      cursesPassed: 0,
      roundPeakDoom: INITIAL_DOOM,
      peakSurvivedDoom: 0,
    };

    this.players.push(player);
    this.emptySince = null;
    this.attachConnection(connectionId, player);
    this.persist();
    this.rescheduleAlarm();
    this.sendSnapshot(connectionId, player);
    this.broadcastPlayers([connectionId]);
  }

  private handleSwapAvatar(
    connectionId: string,
    avatarId: PresetAvatarId,
  ): void {
    const player = this.getAuthenticatedPlayer(connectionId);
    if (!player) return;

    if (this.phase !== "WAITING") {
      this.sendError(
        connectionId,
        "ROOM_LOCKED",
        "Avatars can only be changed while waiting.",
      );
      return;
    }

    const takenByOther = this.players.some(
      (p) => p.id !== player.id && p.avatarId === avatarId,
    );
    if (takenByOther) {
      this.sendError(
        connectionId,
        "AVATAR_TAKEN",
        "That avatar is already taken by another player.",
      );
      return;
    }

    player.avatarId = avatarId;
    this.persist();
    this.broadcastPlayers();
  }

  private handleKickPlayer(
    connectionId: string,
    targetPlayerId: string,
  ): void {
    const caller = this.getAuthenticatedPlayer(connectionId);
    if (!caller) return;

    if (this.phase !== "WAITING") {
      this.sendError(
        connectionId,
        "ROOM_LOCKED",
        "Players can only be kicked while waiting.",
      );
      return;
    }

    if (!caller.isHost) {
      this.sendError(
        connectionId,
        "NOT_HOST",
        "Only the Host can kick players.",
      );
      return;
    }

    if (targetPlayerId === caller.id) {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        "Host cannot kick themselves.",
      );
      return;
    }

    const target = this.players.find((p) => p.id === targetPlayerId);
    if (!target) {
      this.sendError(connectionId, "INVALID_PAYLOAD", "Player not found.");
      return;
    }

    const targetConnId = this.playerIdToConnectionId.get(target.id);
    if (targetConnId) {
      this.send(targetConnId, {
        type: "kicked",
        reason: "You were removed from the Room by the Host.",
      });
      this.connectionToPlayerId.delete(targetConnId);
      this.playerIdToConnectionId.delete(target.id);
      this.transport.close(targetConnId, 4001, "Kicked by Host");
    }

    this.removePlayer(target.id);
    if (this.players.every((p) => !p.connected) && this.emptySince === null) {
      this.emptySince = this.clock();
    }

    this.persist();
    this.rescheduleAlarm();
    this.broadcastPlayers();
  }

  private handleStartMatch(connectionId: string): void {
    const caller = this.getAuthenticatedPlayer(connectionId);
    if (!caller) return;

    if (this.phase !== "WAITING") {
      this.sendError(
        connectionId,
        "ROOM_LOCKED",
        "A Match is already in progress or finished.",
      );
      return;
    }

    if (!caller.isHost) {
      this.sendError(
        connectionId,
        "NOT_HOST",
        "Only the Host can start the Match.",
      );
      return;
    }

    if (this.players.length < MIN_PLAYERS || this.players.length > MAX_PLAYERS) {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        `Need ${MIN_PLAYERS}–${MAX_PLAYERS} players to start a Match.`,
      );
      return;
    }

    const now = this.clock();
    this.phase = "IN_MATCH";
    this.matchPhase = "ROUND_INTRO";
    this.round = 1;
    this.initialPlayerCount = this.players.length;
    this.totalRounds = Math.max(1, this.initialPlayerCount - 1);
    this.sacrificedPlayerId = null;
    this.winnerId = null;
    this.endReason = null;
    this.postMatchClosingBeat = null;
    this.eliminations = [];
    this.feed = [];
    this.copyEngine.reset();
    this.activeCurses = [];
    this.isSuddenDeath = false;
    this.roundId = this.generateId();
    this.roundPublicMessages = [];
    this.roundWhispers = [];
    this.lastWhisperInterceptAt = null;
    this.roundWhisperInterceptCount = 0;
    this.whisperFallbackTriggered = false;
    this.whisperFallbackAt = null;
    this.lastSpamMockeryAt = null;
    this.resolvingCapAt = null;
    this.lastLeakedWhisper = null;
    this.entityMood = pickNextMood(null, this.random);
    this.previousRoundMood = this.entityMood;
    const introText = this.copyEngine.drawBeat("ROUND_INTRO_FIRST");
    const hint = this.copyEngine.drawMoodHint(this.entityMood);
    this.phaseEndsAt = now + ROUND_INTRO_MS;

    for (const p of this.players) {
      p.alive = true;
      p.doom = INITIAL_DOOM;
      p.lastChatAt = null;
      p.lastWhisperAt = null;
      p.leakedWhisperCount = 0;
      p.lastCurseAt = null;
      p.cursesReceived = 0;
      p.cursesFailed = 0;
      p.cursesPassed = 0;
      p.roundPeakDoom = INITIAL_DOOM;
      p.peakSurvivedDoom = 0;
    }

    this.persist();
    this.rescheduleAlarm();
    this.broadcastPhaseChanged(now);
    this.emitEntityAnnouncement("ROUND_INTRO", introText, now);
    this.emitEntityAnnouncement("MOOD_HINT", hint, now);
    this.logger.info("match_started", {
      roomCode: this.roomCode,
      playerCount: this.players.length,
      totalRounds: this.totalRounds,
    });
  }

  private handleCastCurse(
    connectionId: string,
    targetPlayerId: string,
    rawWord: string,
  ): void {
    const ghost = this.getAuthenticatedPlayer(connectionId);
    if (!ghost) return;

    if (this.phase !== "IN_MATCH" || this.matchPhase !== "ROUND_ACTIVE") {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        "Curses can only be cast while the round is active.",
      );
      return;
    }

    if (ghost.alive) {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        "Only Ghosts can cast Curses.",
      );
      return;
    }

    const target = this.players.find(
      (p) => p.id === targetPlayerId && p.alive,
    );
    if (!target) {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        "Target must be a living player.",
      );
      return;
    }

    const word = rawWord.trim();
    if (!isValidCurseWord(word)) {
      this.sendError(
        connectionId,
        "INVALID_CURSE_WORD",
        "Curse must be a single word (2–20 letters, optional internal hyphen or apostrophe).",
      );
      return;
    }

    const now = this.clock();
    if (
      ghost.lastCurseAt !== null &&
      now - ghost.lastCurseAt < CURSE_COOLDOWN_MS
    ) {
      const retryAfterMs = CURSE_COOLDOWN_MS - (now - ghost.lastCurseAt);
      this.sendError(
        connectionId,
        "COOLDOWN_ACTIVE",
        "Wait before casting another Curse.",
        retryAfterMs,
      );
      return;
    }

    const normalized = word.toLowerCase();
    const duplicate = this.activeCurses.some(
      (c) =>
        c.targetPlayerId === target.id && c.word.toLowerCase() === normalized,
    );
    if (duplicate) {
      this.sendError(
        connectionId,
        "DUPLICATE_CURSE",
        `${target.name} is already cursed with "${word}".`,
      );
      return;
    }

    const curse: ActiveCurse = {
      id: this.generateId(),
      ghostPlayerId: ghost.id,
      targetPlayerId: target.id,
      word,
      appliedAt: now,
    };

    ghost.lastCurseAt = now;
    target.cursesReceived += 1;
    this.activeCurses.push(curse);
    this.persist();

    this.sendCurseScoped(target.id, {
      type: "curse_applied",
      curse,
    });
  }

  private sendCurseScoped(targetPlayerId: string, message: ServerMessage): void {
    const serialized = JSON.stringify(message);
    for (const p of this.players) {
      if (!p.connected) continue;
      if (p.id !== targetPlayerId && p.alive) continue;
      const connId = this.playerIdToConnectionId.get(p.id);
      if (connId) {
        this.transport.send(connId, serialized);
      }
    }
  }

  private handleSendChat(connectionId: string, rawText: string): void {
    const player = this.getAuthenticatedPlayer(connectionId);
    if (!player) return;

    if (this.phase !== "IN_MATCH" || this.matchPhase !== "ROUND_ACTIVE") {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        "Public chat is only open during an active round.",
      );
      return;
    }

    if (!player.alive) {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        "Ghosts cannot plead in public chat.",
      );
      return;
    }

    const text = rawText.trim();
    if (text.length < MIN_CHAT_LENGTH || text.length > MAX_CHAT_LENGTH) {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        `Message must be ${MIN_CHAT_LENGTH}–${MAX_CHAT_LENGTH} characters.`,
      );
      return;
    }

    const now = this.clock();
    if (player.lastChatAt !== null && now - player.lastChatAt < CHAT_COOLDOWN_MS) {
      const retryAfterMs = CHAT_COOLDOWN_MS - (now - player.lastChatAt);
      this.sendError(
        connectionId,
        "COOLDOWN_ACTIVE",
        "Wait before pleading again.",
        retryAfterMs,
      );
      return;
    }

    player.lastChatAt = now;
    const id = this.generateId();
    const recentBefore = this.roundPublicMessages.slice(-RECENT_CONTEXT_LIMIT);
    this.roundPublicMessages.push({ speakerName: player.name, text });
    if (this.roundPublicMessages.length > RECENT_CONTEXT_LIMIT) {
      this.roundPublicMessages.splice(
        0,
        this.roundPublicMessages.length - RECENT_CONTEXT_LIMIT,
      );
    }

    this.pushFeedItem({
      kind: "chat",
      id,
      playerId: player.id,
      playerName: player.name,
      avatarId: player.avatarId,
      text,
      timestamp: now,
    });

    const targetCurses = this.activeCurses.filter(
      (c) => c.targetPlayerId === player.id,
    );
    if (targetCurses.length > 0) {
      this.activeCurses = this.activeCurses.filter(
        (c) => c.targetPlayerId !== player.id,
      );
    }

    this.persist();

    const payload: ServerMessage = {
      type: "chat_message",
      id,
      playerId: player.id,
      playerName: player.name,
      avatarId: player.avatarId,
      text,
      timestamp: now,
      pendingJudge: Boolean(this.jevEvaluator),
    };
    this.transport.broadcast(JSON.stringify(payload));

    const matchedWords: string[] = [];
    const missingCurseIds = new Set<string>();
    for (const curse of targetCurses) {
      if (this.matchesCurseWord(text, curse.word)) {
        matchedWords.push(curse.word);
      } else {
        missingCurseIds.add(curse.id);
      }
    }

    if (this.jevEvaluator) {
      const roundId = this.roundId;
      const livingPlayers = this.players
        .filter((p) => p.alive)
        .map((p) => ({ id: p.id, name: p.name, doom: p.doom }));
      const evalPromise = this.jevEvaluator
        .judgeMessage({
          roundId,
          entityMood: this.entityMood,
          moodRubric: MOOD_RUBRICS[this.entityMood],
          livingPlayers,
          recentMessages: recentBefore,
          speaker: { id: player.id, name: player.name },
          messageText: text,
          ...(matchedWords.length > 0 ? { activeCurses: matchedWords } : {}),
        })
        .then((verdict) => {
          this.applyJudgeVerdict(
            player.id,
            id,
            verdict,
            targetCurses,
            missingCurseIds,
          );
        })
        .catch(() => {
          this.handleJudgeFailure(roundId);
        })
        .finally(() => {
          this.pendingEvaluations.delete(evalPromise);
        });
      this.pendingEvaluations.add(evalPromise);
    }
  }

  private handleSendWhisper(
    connectionId: string,
    targetPlayerId: string,
    rawText: string,
  ): void {
    const player = this.getAuthenticatedPlayer(connectionId);
    if (!player) return;

    if (this.phase !== "IN_MATCH" || this.matchPhase !== "ROUND_ACTIVE") {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        "Whispers are only open during an active round.",
      );
      return;
    }

    if (!player.alive) {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        "Ghosts cannot send Whispers.",
      );
      return;
    }

    const livingCount = this.players.filter((p) => p.alive).length;
    if (livingCount < MIN_PLAYERS_FOR_WHISPERS) {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        "Whispers are disabled when 2 or fewer living players remain.",
      );
      return;
    }

    if (targetPlayerId === player.id) {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        "Cannot Whisper to yourself.",
      );
      return;
    }

    const target = this.players.find(
      (p) => p.id === targetPlayerId && p.alive,
    );
    if (!target) {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        "Whisper target must be another living player.",
      );
      return;
    }

    const text = rawText.trim();
    if (text.length < MIN_WHISPER_LENGTH || text.length > MAX_WHISPER_LENGTH) {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        `Whisper must be ${MIN_WHISPER_LENGTH}–${MAX_WHISPER_LENGTH} characters.`,
      );
      return;
    }

    const now = this.clock();
    if (
      player.lastWhisperAt !== null &&
      now - player.lastWhisperAt < WHISPER_COOLDOWN_MS
    ) {
      const retryAfterMs = WHISPER_COOLDOWN_MS - (now - player.lastWhisperAt);
      this.sendError(
        connectionId,
        "COOLDOWN_ACTIVE",
        "Wait before whispering again.",
        retryAfterMs,
      );
      return;
    }

    player.lastWhisperAt = now;
    const id = this.generateId();

    this.roundWhispers.push({
      id,
      senderId: player.id,
      senderName: player.name,
      targetId: target.id,
      targetName: target.name,
      text,
      timestamp: now,
      leaked: false,
    });

    this.pushFeedItem({
      kind: "whisper",
      id,
      senderId: player.id,
      senderName: player.name,
      senderAvatarId: player.avatarId,
      targetId: target.id,
      targetName: target.name,
      text,
      timestamp: now,
    });
    this.persist();

    const payload: ServerMessage = {
      type: "whisper_message",
      id,
      senderId: player.id,
      senderName: player.name,
      senderAvatarId: player.avatarId,
      targetId: target.id,
      targetName: target.name,
      text,
      timestamp: now,
    };

    const senderConnId = this.playerIdToConnectionId.get(player.id);
    if (senderConnId) {
      this.send(senderConnId, payload);
    }
    const targetConnId = this.playerIdToConnectionId.get(target.id);
    if (targetConnId && targetConnId !== senderConnId) {
      this.send(targetConnId, payload);
    }

    this.maybeTriggerBatchWhisperInterception(now);
    this.rescheduleAlarm();
  }

  private maybeTriggerBatchWhisperInterception(now: number): void {
    const unleaked = this.roundWhispers.filter((w) => !w.leaked);
    if (
      unleaked.length >= WHISPER_INTERCEPT_BATCH_SIZE &&
      (this.lastWhisperInterceptAt === null ||
        now - this.lastWhisperInterceptAt >= WHISPER_INTERCEPT_MIN_GAP_MS)
    ) {
      this.triggerWhisperInterception(unleaked);
    }
  }

  private triggerWhisperInterception(unleaked: RoundWhisper[]): void {
    if (this.whisperInterceptInFlight || unleaked.length === 0) return;

    const candidates = unleaked.slice(-WHISPER_INTERCEPT_CANDIDATE_LIMIT);
    const roundId = this.roundId;

    if (candidates.length === 1 || !this.jevEvaluator) {
      this.applyWhisperInterception(roundId, candidates[0]!.id);
      return;
    }

    this.whisperInterceptInFlight = true;
    const evalPromise = this.jevEvaluator
      .pickInterceptedWhisper({
        roundId,
        entityMood: this.entityMood,
        candidates: candidates.map((c) => ({
          id: c.id,
          senderName: c.senderName,
          targetName: c.targetName,
          text: c.text,
        })),
      })
      .then((res) => {
        this.applyWhisperInterception(res.roundId, res.whisperId);
      })
      .catch(() => {
        this.handleJudgeFailure(roundId);
      })
      .finally(() => {
        this.whisperInterceptInFlight = false;
        this.pendingEvaluations.delete(evalPromise);
      });
    this.pendingEvaluations.add(evalPromise);
  }

  private applyWhisperInterception(roundId: string, whisperId: string): void {
    if (this.phase !== "IN_MATCH" || roundId !== this.roundId) return;
    if (
      this.matchPhase !== "ROUND_ACTIVE" &&
      this.matchPhase !== "ROUND_RESOLVING"
    ) {
      return;
    }
    const now = this.clock();
    if (
      this.matchPhase === "ROUND_RESOLVING" &&
      this.resolvingCapAt !== null &&
      now > this.resolvingCapAt
    ) {
      return;
    }

    const unleaked = this.roundWhispers.filter((w) => !w.leaked);
    if (unleaked.length === 0) return;
    const chosen =
      unleaked.find((w) => w.id === whisperId) ?? unleaked[unleaked.length - 1]!;

    chosen.leaked = true;
    this.lastWhisperInterceptAt = now;
    this.roundWhisperInterceptCount += 1;

    const sender = this.players.find((p) => p.id === chosen.senderId);
    if (sender) {
      sender.leakedWhisperCount += 1;
    }
    this.lastLeakedWhisper = {
      whisperId: chosen.id,
      senderId: chosen.senderId,
      senderName: chosen.senderName,
      targetId: chosen.targetId,
      targetName: chosen.targetName,
      text: chosen.text,
      round: this.round,
      timestamp: now,
    };

    const id = this.generateId();
    const headerText = this.drawWhisperLeakBeat(
      chosen.senderName,
      chosen.targetName,
    );
    this.pushFeedItem({
      kind: "whisper_intercepted",
      id,
      whisperId: chosen.id,
      senderId: chosen.senderId,
      senderName: chosen.senderName,
      targetId: chosen.targetId,
      targetName: chosen.targetName,
      headerText,
      whisperText: chosen.text,
      timestamp: now,
    });

    const leakPayload: ServerMessage = {
      type: "whisper_intercepted",
      id,
      whisperId: chosen.id,
      senderId: chosen.senderId,
      senderName: chosen.senderName,
      targetId: chosen.targetId,
      targetName: chosen.targetName,
      headerText,
      whisperText: chosen.text,
      timestamp: now,
    };
    this.transport.broadcast(JSON.stringify(leakPayload));

    let sacrificed = false;
    if (sender && sender.alive) {
      const oldDoom = sender.doom;
      const newDoom = Math.min(100, oldDoom + WHISPER_INTERCEPT_DOOM_PENALTY);
      sender.doom = newDoom;
      sender.roundPeakDoom = Math.max(sender.roundPeakDoom, newDoom);
      const doomPayload: ServerMessage = {
        type: "doom_updated",
        updates: [
          {
            playerId: sender.id,
            doom: newDoom,
            delta: newDoom - oldDoom,
          },
        ],
        sourceMessageId: id,
      };
      this.transport.broadcast(JSON.stringify(doomPayload));
      if (newDoom >= 100) {
        sacrificed = true;
        this.sacrificePlayer(sender, now, "SPIKE");
      }
    }

    if (!sacrificed) {
      this.persist();
    }
    this.rescheduleAlarm();
  }

  private matchesCurseWord(messageText: string, word: string): boolean {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(messageText);
  }

  private applyJudgeVerdict(
    speakerId: string,
    sourceMessageId: string,
    verdict: JudgeMessageResult,
    evaluatedCurses: ActiveCurse[] = [],
    missingCurseIds: Set<string> = new Set(),
  ): void {
    if (this.phase !== "IN_MATCH") return;
    if (verdict.roundId !== this.roundId) return;
    if (
      this.matchPhase !== "ROUND_ACTIVE" &&
      this.matchPhase !== "ROUND_RESOLVING"
    ) {
      return;
    }
    const now = this.clock();
    if (
      this.matchPhase === "ROUND_RESOLVING" &&
      this.resolvingCapAt !== null &&
      now > this.resolvingCapAt
    ) {
      return;
    }

    const speaker = this.players.find((p) => p.id === speakerId && p.alive);
    if (!speaker) return;

    const deltas = new Map<string, number>();
    let emitSpamMockery = false;
    const isSpam = verdict.isLowEffortSpamNoul >= 0.7;

    if (isSpam) {
      deltas.set(speaker.id, 8);
      if (
        this.lastSpamMockeryAt === null ||
        now - this.lastSpamMockeryAt >= SPAM_MOCKERY_COOLDOWN_MS
      ) {
        this.lastSpamMockeryAt = now;
        emitSpamMockery = true;
      }
    } else {
      let speakerDelta = Math.round((2.0 - verdict.persuasivenessScore) * 6);
      if (
        verdict.targetBlamed === "SELF" &&
        verdict.targetBlamedConfidence >= 0.6
      ) {
        speakerDelta += 8;
      }
      deltas.set(speaker.id, speakerDelta);

      if (
        verdict.targetBlamed !== "SELF" &&
        verdict.targetBlamed !== "NONE" &&
        verdict.targetBlamedConfidence >= 0.6 &&
        verdict.persuasivenessScore > 2.0
      ) {
        const target = this.players.find(
          (p) => p.id === verdict.targetBlamed && p.alive && p.id !== speaker.id,
        );
        if (target) {
          const blameDelta = Math.round(
            (verdict.persuasivenessScore - 2.0) * 5,
          );
          if (blameDelta > 0) {
            deltas.set(target.id, (deltas.get(target.id) ?? 0) + blameDelta);
          }
        }
      }
    }

    const curseResultsPayload: CurseResolutionItem[] = [];
    let cursePassedCount = 0;
    let curseFailedCount = 0;
    for (const curse of evaluatedCurses) {
      if (isSpam) {
        curseFailedCount += 1;
        curseResultsPayload.push({
          curseId: curse.id,
          word: curse.word,
          passed: false,
          reason: "SPAM",
        });
      } else if (missingCurseIds.has(curse.id)) {
        curseFailedCount += 1;
        curseResultsPayload.push({
          curseId: curse.id,
          word: curse.word,
          passed: false,
          reason: "MISSING_WORD",
        });
      } else if (verdict.curseResults?.[curse.word] === true) {
        cursePassedCount += 1;
        curseResultsPayload.push({
          curseId: curse.id,
          word: curse.word,
          passed: true,
          reason: "NATURAL",
        });
      } else {
        curseFailedCount += 1;
        curseResultsPayload.push({
          curseId: curse.id,
          word: curse.word,
          passed: false,
          reason: "UNNATURAL",
        });
      }
    }

    if (curseResultsPayload.length > 0) {
      speaker.cursesPassed += cursePassedCount;
      speaker.cursesFailed += curseFailedCount;
      if (curseFailedCount > 0) {
        deltas.set(
          speaker.id,
          (deltas.get(speaker.id) ?? 0) +
            curseFailedCount * CURSE_FAIL_DOOM_PENALTY,
        );
      }
    }

    const updates: Array<{ playerId: string; doom: number; delta: number }> = [];
    for (const [playerId, rawDelta] of deltas) {
      const target = this.players.find((p) => p.id === playerId && p.alive);
      if (!target) continue;
      const oldDoom = target.doom;
      const newDoom = Math.max(0, Math.min(100, oldDoom + rawDelta));
      target.doom = newDoom;
      target.roundPeakDoom = Math.max(target.roundPeakDoom, newDoom);
      updates.push({
        playerId,
        doom: newDoom,
        delta: newDoom - oldDoom,
      });
    }

    this.persist();

    if (updates.length > 0) {
      const payload: ServerMessage = {
        type: "doom_updated",
        updates,
        sourceMessageId,
      };
      this.transport.broadcast(JSON.stringify(payload));
    }

    if (emitSpamMockery) {
      this.emitEntityAnnouncement(
        "SPAM_MOCKERY",
        this.copyEngine.drawBeat("SPAM_MOCKERY", { player: speaker.name }),
        now,
      );
      this.persist();
    }

    if (curseResultsPayload.length > 0) {
      this.sendCurseScoped(speaker.id, {
        type: "curse_resolved",
        targetPlayerId: speaker.id,
        sourceMessageId,
        results: curseResultsPayload,
      });

      const passedWords = curseResultsPayload
        .filter((r) => r.passed)
        .map((r) => r.word);
      const failedWords = curseResultsPayload
        .filter((r) => !r.passed)
        .map((r) => r.word);
      let curseBeatType = "CURSE_MIXED";
      if (curseFailedCount === 0) {
        curseBeatType = "CURSE_PASS";
      } else if (cursePassedCount === 0) {
        curseBeatType = "CURSE_FAIL";
      }
      const curseText = this.drawCurseBeat(
        speaker.name,
        passedWords,
        failedWords,
      );
      this.emitEntityAnnouncement(curseBeatType, curseText, now);
    }

    const maxed = this.players.filter((p) => p.alive && p.doom >= 100);
    if (maxed.length === 1) {
      this.sacrificePlayer(maxed[0]!, now, "SPIKE");
      this.rescheduleAlarm();
    } else if (maxed.length > 1) {
      if (!this.isSuddenDeath) {
        this.triggerSuddenDeath(now);
      } else {
        const victim = this.breakTieLongestSilentThenRandom(maxed);
        this.sacrificePlayer(victim, now, "TIEBREAK");
      }
      this.rescheduleAlarm();
    }
  }

  private sacrificePlayer(
    victim: InternalPlayer,
    now: number,
    cause: "TIMER" | "SPIKE" | "TIEBREAK",
  ): void {
    victim.alive = false;
    this.recordElimination(victim, cause);
    for (const p of this.players) {
      if (p.alive) {
        p.peakSurvivedDoom = Math.max(p.peakSurvivedDoom, p.roundPeakDoom);
      }
    }
    this.sacrificedPlayerId = victim.id;
    this.isSuddenDeath = false;
    this.resolvingCapAt = null;
    this.activeCurses = [];
    this.roundId = this.generateId();
    this.matchPhase = "SACRIFICE_REVEAL";
    this.phaseEndsAt = now + SACRIFICE_REVEAL_MS;
    const pool =
      cause === "SPIKE"
        ? "SACRIFICE_SPIKE"
        : cause === "TIEBREAK"
          ? "SACRIFICE_TIEBREAK"
          : "SACRIFICE_TIMER";
    const text = this.copyEngine.drawBeat(pool, { player: victim.name });
    this.persist();
    this.broadcastPhaseChanged(now);
    this.emitEntityAnnouncement("SACRIFICE_REVEAL", text, now);
  }

  private triggerSuddenDeath(now: number): void {
    for (const p of this.players) {
      if (p.alive && p.doom >= 100) {
        p.doom = SUDDEN_DEATH_CLAMP_DOOM;
        p.roundPeakDoom = Math.max(p.roundPeakDoom, p.doom);
      }
      p.lastCurseAt = null;
    }
    this.activeCurses = [];
    this.isSuddenDeath = true;
    this.sacrificedPlayerId = null;
    this.roundId = this.generateId();
    this.roundPublicMessages = [];
    this.roundWhispers = [];
    this.lastWhisperInterceptAt = null;
    this.roundWhisperInterceptCount = 0;
    this.whisperFallbackTriggered = false;
    this.whisperFallbackAt =
      SUDDEN_DEATH_DURATION_MS > WHISPER_INTERCEPT_FALLBACK_REMAINING_MS
        ? now + SUDDEN_DEATH_DURATION_MS - WHISPER_INTERCEPT_FALLBACK_REMAINING_MS
        : null;
    this.resolvingCapAt = null;
    this.entityMood = pickNextMood(this.entityMood, this.random);
    this.previousRoundMood = this.entityMood;
    const sdText = this.copyEngine.drawBeat("ROUND_INTRO_SUDDEN_DEATH");
    const hint = this.copyEngine.drawMoodHint(this.entityMood);

    this.matchPhase = "ROUND_ACTIVE";
    this.phaseEndsAt = now + SUDDEN_DEATH_DURATION_MS;
    this.persist();
    this.broadcastPhaseChanged(now);
    this.emitEntityAnnouncement("SUDDEN_DEATH", sdText, now);
    this.emitEntityAnnouncement("MOOD_HINT", hint, now);
  }

  private breakTieLongestSilentThenRandom(
    tied: InternalPlayer[],
  ): InternalPlayer {
    let earliestChat = Infinity;
    for (const p of tied) {
      const score = p.lastChatAt ?? -Infinity;
      if (score < earliestChat) {
        earliestChat = score;
      }
    }
    const longestSilent = tied.filter(
      (p) => (p.lastChatAt ?? -Infinity) === earliestChat,
    );
    const idx = Math.floor(this.random() * longestSilent.length);
    return longestSilent[idx] ?? longestSilent[0]!;
  }

  private handleJudgeFailure(roundId: string): void {
    if (this.phase !== "IN_MATCH" || roundId !== this.roundId) return;
    const now = this.clock();
    this.phase = "POST_MATCH";
    this.matchPhase = null;
    this.phaseEndsAt = null;
    this.resolvingCapAt = null;
    this.isSuddenDeath = false;
    this.sacrificedPlayerId = null;
    this.winnerId = null;
    this.endReason = "JUDGE_ERROR";
    this.postMatchClosingBeat = POST_MATCH_JUDGE_ERROR;
    this.roundId = this.generateId();
    this.persist();
    this.rescheduleAlarm();
    this.broadcastPhaseChanged(now);
    this.broadcastMatchEnded(now);
    this.emitEntityAnnouncement(
      "POST_MATCH_JUDGE_ERROR",
      POST_MATCH_JUDGE_ERROR,
      now,
    );
    this.logger.error("match_ended", {
      roomCode: this.roomCode,
      endReason: this.endReason,
      round: this.round,
      winnerId: null,
    });
  }

  private handleLeaveRoom(connectionId: string): void {
    const player = this.getAuthenticatedPlayer(connectionId);
    if (!player) return;

    const wasLivingInMatch = this.phase === "IN_MATCH" && player.alive;
    if (wasLivingInMatch) {
      player.doom = 100;
      player.alive = false;
      this.recordElimination(player, "DISCONNECT");
    }

    this.connectionToPlayerId.delete(connectionId);
    this.playerIdToConnectionId.delete(player.id);
    this.removePlayer(player.id);
    this.transport.close(connectionId, 1000, "Left Room");

    if (wasLivingInMatch) {
      const now = this.clock();
      this.emitEntityAnnouncement(
        "SACRIFICE_DISCONNECT",
        this.copyEngine.drawBeat("SACRIFICE_DISCONNECT", { player: player.name }),
        now,
      );
      const living = this.players.filter((p) => p.alive);
      if (living.length <= 1) {
        this.endMatch(living, now);
        this.rescheduleAlarm();
        return;
      }
    }

    if (this.players.every((p) => !p.connected) && this.emptySince === null) {
      this.emptySince = this.clock();
    }

    this.persist();
    this.rescheduleAlarm();
    this.broadcastPlayers();
  }

  private handlePlayAgain(connectionId: string): void {
    const caller = this.getAuthenticatedPlayer(connectionId);
    if (!caller) return;

    if (this.phase !== "POST_MATCH") {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        "Can only play again after a Match ends.",
      );
      return;
    }

    if (!caller.isHost) {
      this.sendError(
        connectionId,
        "NOT_HOST",
        "Only the Host can start a rematch.",
      );
      return;
    }

    const now = this.clock();
    this.phase = "WAITING";
    this.matchPhase = null;
    this.round = 0;
    this.totalRounds = 0;
    this.initialPlayerCount = 0;
    this.phaseEndsAt = null;
    this.sacrificedPlayerId = null;
    this.winnerId = null;
    this.endReason = null;
    this.postMatchClosingBeat = null;
    this.eliminations = [];
    this.feed = [];
    this.copyEngine.reset();
    this.activeCurses = [];
    this.isSuddenDeath = false;
    this.roundId = "";
    this.roundPublicMessages = [];
    this.roundWhispers = [];
    this.lastWhisperInterceptAt = null;
    this.roundWhisperInterceptCount = 0;
    this.whisperFallbackTriggered = false;
    this.whisperFallbackAt = null;
    this.lastSpamMockeryAt = null;
    this.resolvingCapAt = null;
    this.lastLeakedWhisper = null;
    this.lastActivityAt = now;

    for (const p of this.players) {
      p.alive = true;
      p.doom = INITIAL_DOOM;
      p.lastChatAt = null;
      p.lastWhisperAt = null;
      p.leakedWhisperCount = 0;
      p.lastCurseAt = null;
      p.cursesReceived = 0;
      p.cursesFailed = 0;
      p.cursesPassed = 0;
      p.roundPeakDoom = INITIAL_DOOM;
      p.peakSurvivedDoom = 0;
    }

    this.persist();
    this.rescheduleAlarm();
    this.broadcastPhaseChanged(now);
    this.logger.info("rematch_started", {
      roomCode: this.roomCode,
      playerCount: this.players.length,
    });
  }

  private attachConnection(connectionId: string, player: InternalPlayer): void {
    const previousConnId = this.playerIdToConnectionId.get(player.id);
    if (previousConnId && previousConnId !== connectionId) {
      this.connectionToPlayerId.delete(previousConnId);
      this.transport.close(previousConnId, 4000, "Superseded by reconnect");
    }
    this.connectionToPlayerId.set(connectionId, player.id);
    this.playerIdToConnectionId.set(player.id, connectionId);
    this.transport.onAttachPlayer?.(connectionId, player.id);
  }

  private endMatch(living: InternalPlayer[], now: number): void {
    for (const p of living) {
      p.peakSurvivedDoom = Math.max(p.peakSurvivedDoom, p.roundPeakDoom);
    }
    this.phase = "POST_MATCH";
    this.matchPhase = null;
    this.phaseEndsAt = null;
    this.sacrificedPlayerId = null;
    this.winnerId = living[0]?.id ?? null;
    this.endReason = living.length === 1 ? "SURVIVOR" : "ALL_CLAIMED";
    this.lastActivityAt = now;
    const closingText = this.drawPostMatchBeat(
      this.endReason,
      living[0]?.name,
    );
    this.postMatchClosingBeat = closingText;
    this.persist();
    this.broadcastPhaseChanged(now);
    this.broadcastMatchEnded(now);
    this.logger.info("match_ended", {
      roomCode: this.roomCode,
      endReason: this.endReason,
      round: this.round,
      winnerId: this.winnerId,
    });
    this.emitEntityAnnouncement(
      this.endReason === "SURVIVOR"
        ? "POST_MATCH_SURVIVOR"
        : "POST_MATCH_ALL_CLAIMED",
      closingText,
      now,
    );
  }

  /** Helper for #20 Whispers: draws a non-repeating Whisper leak header. */
  drawWhisperLeakBeat(playerName: string, targetName: string): string {
    return this.copyEngine.drawBeat("WHISPER_LEAK", {
      player: playerName,
      target: targetName,
    });
  }

  /** Helper for #21 Ghost Curses: draws a collapsed Curse pass/fail callout. */
  drawCurseBeat(
    playerName: string,
    passedWords: readonly string[],
    failedWords: readonly string[],
  ): string {
    return this.copyEngine.drawCurseBeat(playerName, passedWords, failedWords);
  }

  /** Helper for #24 Post-match: draws a closing Entity beat. */
  drawPostMatchBeat(
    endReason: "SURVIVOR" | "ALL_CLAIMED",
    winnerName?: string,
  ): string {
    if (endReason === "SURVIVOR") {
      return this.copyEngine.drawBeat("POST_MATCH_SURVIVOR", {
        player: winnerName ?? "Survivor",
      });
    }
    return this.copyEngine.drawBeat("POST_MATCH_ALL_CLAIMED");
  }

  private recordElimination(
    player: InternalPlayer,
    cause: EliminationCause,
  ): void {
    this.eliminations.push({
      round: Math.max(1, this.round),
      playerId: player.id,
      playerName: player.name,
      avatarId: player.avatarId,
      cause,
    });
  }

  private computePostMatchAwards(): PostMatchAward[] {
    const awards: PostMatchAward[] = [];

    const closestCandidates = this.players.filter(
      (p) => p.peakSurvivedDoom >= CLOSEST_CALL_DOOM_THRESHOLD,
    );
    if (closestCandidates.length > 0) {
      closestCandidates.sort((a, b) => {
        if (b.peakSurvivedDoom !== a.peakSurvivedDoom) {
          return b.peakSurvivedDoom - a.peakSurvivedDoom;
        }
        if (a.alive !== b.alive) {
          return a.alive ? -1 : 1;
        }
        return a.joinedAt - b.joinedAt;
      });
      const winner = closestCandidates[0]!;
      awards.push({
        id: "closest_call",
        title: "Closest Call",
        playerId: winner.id,
        playerName: winner.name,
        detail: `${winner.peakSurvivedDoom}% peak Doom`,
      });
    }

    const curseCandidates = this.players.filter((p) => p.cursesReceived >= 1);
    if (curseCandidates.length > 0) {
      curseCandidates.sort((a, b) => {
        if (b.cursesReceived !== a.cursesReceived) {
          return b.cursesReceived - a.cursesReceived;
        }
        return a.joinedAt - b.joinedAt;
      });
      const magnet = curseCandidates[0]!;
      awards.push({
        id: "curse_magnet",
        title: "Curse Magnet",
        playerId: magnet.id,
        playerName: magnet.name,
        detail: `${magnet.cursesReceived} Curse${magnet.cursesReceived === 1 ? "" : "s"} endured`,
      });
    }

    if (this.lastLeakedWhisper !== null) {
      awards.push({
        id: "exposed",
        title: "Exposed",
        playerId: this.lastLeakedWhisper.senderId,
        playerName: this.lastLeakedWhisper.senderName,
        detail: `To ${this.lastLeakedWhisper.targetName}: "${this.lastLeakedWhisper.text}"`,
      });
    }

    return awards;
  }

  private buildPostMatchSummary(): PostMatchSummary | null {
    if (this.phase !== "POST_MATCH" || !this.endReason) return null;
    const closingBeat =
      this.postMatchClosingBeat ??
      (this.endReason === "JUDGE_ERROR"
        ? POST_MATCH_JUDGE_ERROR
        : this.drawPostMatchBeat(
            this.endReason,
            this.players.find((p) => p.id === this.winnerId)?.name,
          ));
    return {
      endReason: this.endReason,
      winnerId: this.winnerId,
      closingBeat,
      eliminations: [...this.eliminations],
      awards: this.computePostMatchAwards(),
    };
  }

  private transferHostFrom(departingPlayerId: string): void {
    const candidates = this.players.filter((p) => p.id !== departingPlayerId);
    if (candidates.length === 0) return;
    const connectedCandidates = candidates.filter((p) => p.connected);
    const pool = connectedCandidates.length > 0 ? connectedCandidates : candidates;
    const nextHost = pool.reduce((oldest, candidate) =>
      candidate.joinedAt < oldest.joinedAt ? candidate : oldest,
    );
    for (const p of this.players) {
      p.isHost = p.id === nextHost.id;
    }
  }

  private removePlayer(playerId: string): void {
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx === -1) return;
    const [removed] = this.players.splice(idx, 1);

    const connId = this.playerIdToConnectionId.get(playerId);
    if (connId) {
      this.connectionToPlayerId.delete(connId);
      this.playerIdToConnectionId.delete(playerId);
    }

    if (removed?.isHost && this.players.length > 0) {
      const nextHost = this.players.reduce((oldest, candidate) =>
        candidate.joinedAt < oldest.joinedAt ? candidate : oldest,
      );
      for (const p of this.players) {
        p.isHost = p.id === nextHost.id;
      }
    }
  }

  private pickAvatarForJoin(preferred?: PresetAvatarId): PresetAvatarId {
    const taken = new Set(this.players.map((p) => p.avatarId));
    if (preferred && !taken.has(preferred)) {
      return preferred;
    }
    const available = PRESET_AVATARS.find((a) => !taken.has(a.id));
    return available?.id ?? PRESET_AVATARS[0].id;
  }

  private getAuthenticatedPlayer(connectionId: string): InternalPlayer | null {
    const playerId = this.connectionToPlayerId.get(connectionId);
    if (!playerId) {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        "Must join the Room first.",
      );
      return null;
    }
    const player = this.players.find((p) => p.id === playerId) ?? null;
    if (!player) {
      this.sendError(
        connectionId,
        "INVALID_PAYLOAD",
        "Player seat not found.",
      );
      return null;
    }
    return player;
  }

  private toPublicPlayers(): PublicPlayer[] {
    return this.players.map((p) => ({
      id: p.id,
      name: p.name,
      avatarId: p.avatarId,
      isHost: p.isHost,
      connected: p.connected,
      joinedAt: p.joinedAt,
      alive: p.alive,
      doom: p.doom,
    }));
  }

  private sendSnapshot(connectionId: string, recipient: InternalPlayer): void {
    const now = this.clock();
    const chatCooldownEndsAt =
      recipient.lastChatAt !== null &&
      now - recipient.lastChatAt < CHAT_COOLDOWN_MS
        ? recipient.lastChatAt + CHAT_COOLDOWN_MS
        : null;
    const whisperCooldownEndsAt =
      recipient.lastWhisperAt !== null &&
      now - recipient.lastWhisperAt < WHISPER_COOLDOWN_MS
        ? recipient.lastWhisperAt + WHISPER_COOLDOWN_MS
        : null;
    const visibleFeed = this.feed.filter((item) => {
      if (item.kind !== "whisper") return true;
      if (this.phase === "POST_MATCH") return false;
      return item.senderId === recipient.id || item.targetId === recipient.id;
    });
    const curseCooldownEndsAt =
      !recipient.alive &&
      recipient.lastCurseAt !== null &&
      now - recipient.lastCurseAt < CURSE_COOLDOWN_MS
        ? recipient.lastCurseAt + CURSE_COOLDOWN_MS
        : null;
    const visibleCurses = recipient.alive
      ? this.activeCurses.filter((c) => c.targetPlayerId === recipient.id)
      : [...this.activeCurses];
    this.send(connectionId, {
      type: "room_snapshot",
      roomCode: this.roomCode,
      phase: this.phase,
      selfPlayerId: recipient.id,
      playerToken: recipient.playerToken,
      players: this.toPublicPlayers(),
      serverNow: now,
      phaseEndsAt: this.phaseEndsAt,
      matchPhase: this.matchPhase,
      round: this.round,
      totalRounds: this.totalRounds,
      sacrificedPlayerId: this.sacrificedPlayerId,
      winnerId: this.winnerId,
      endReason: this.endReason,
      postMatchSummary: this.buildPostMatchSummary(),
      feed: visibleFeed,
      chatCooldownEndsAt,
      whisperCooldownEndsAt,
      activeCurses: visibleCurses,
      curseCooldownEndsAt,
    });
  }

  private broadcastPhaseChanged(now: number): void {
    const payload: ServerMessage = {
      type: "phase_changed",
      phase: this.phase,
      matchPhase: this.matchPhase,
      round: this.round,
      totalRounds: this.totalRounds,
      serverNow: now,
      phaseEndsAt: this.phaseEndsAt,
      players: this.toPublicPlayers(),
      sacrificedPlayerId: this.sacrificedPlayerId,
      winnerId: this.winnerId,
      endReason: this.endReason,
      postMatchSummary: this.buildPostMatchSummary(),
    };
    this.transport.broadcast(JSON.stringify(payload));
  }

  private broadcastMatchEnded(now: number): void {
    const postMatchSummary = this.buildPostMatchSummary();
    if (!this.endReason || !postMatchSummary) return;
    const payload: ServerMessage = {
      type: "match_ended",
      roomStatus: "POST_MATCH",
      round: this.round,
      totalRounds: this.totalRounds,
      serverNow: now,
      players: this.toPublicPlayers(),
      winnerId: this.winnerId,
      endReason: this.endReason,
      postMatchSummary,
    };
    this.transport.broadcast(JSON.stringify(payload));
  }

  private emitEntityAnnouncement(
    beatType: string,
    text: string,
    timestamp: number,
  ): void {
    const id = this.generateId();
    this.pushFeedItem({
      kind: "entity",
      id,
      beatType,
      text,
      timestamp,
    });
    const payload: ServerMessage = {
      type: "entity_announcement",
      id,
      beatType,
      text,
      timestamp,
    };
    this.transport.broadcast(JSON.stringify(payload));
  }

  private pushFeedItem(item: FeedItem): void {
    this.feed.push(item);
    if (this.feed.length > MAX_FEED_ITEMS) {
      this.feed.splice(0, this.feed.length - MAX_FEED_ITEMS);
    }
  }

  private broadcastPlayers(excludeConnectionIds?: string[]): void {
    const payload: ServerMessage = {
      type: "player_updated",
      players: this.toPublicPlayers(),
    };
    this.transport.broadcast(JSON.stringify(payload), excludeConnectionIds);
  }

  private send(connectionId: string, message: ServerMessage): void {
    this.transport.send(connectionId, JSON.stringify(message));
  }

  private sendError(
    connectionId: string,
    code: ErrorCode,
    message: string,
    retryAfterMs?: number,
  ): void {
    this.send(connectionId, {
      type: "error",
      code,
      message,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  private wipeRoom(): void {
    for (const connId of [...this.connectionToPlayerId.keys()]) {
      this.transport.close(connId, 1000, "Room expired");
    }
    this.connectionToPlayerId.clear();
    this.playerIdToConnectionId.clear();
    this.players = [];
    this.feed = [];
    this.phase = "WAITING";
    this.matchPhase = null;
    this.phaseEndsAt = null;
    this.emptySince = null;
    this.lastActivityAt = null;
    this.storage.deleteAll();
  }

  private rescheduleAlarm(): void {
    let earliest: number | null = null;
    const consider = (at: number | null) => {
      if (at === null) return;
      if (earliest === null || at < earliest) {
        earliest = at;
      }
    };

    if (this.phase === "IN_MATCH") {
      consider(this.phaseEndsAt);
      if (this.matchPhase === "ROUND_ACTIVE") {
        if (
          !this.whisperFallbackTriggered &&
          this.roundWhisperInterceptCount === 0 &&
          this.whisperFallbackAt !== null
        ) {
          consider(this.whisperFallbackAt);
        }
        if (
          this.lastWhisperInterceptAt !== null &&
          this.roundWhispers.filter((w) => !w.leaked).length >=
            WHISPER_INTERCEPT_BATCH_SIZE
        ) {
          consider(this.lastWhisperInterceptAt + WHISPER_INTERCEPT_MIN_GAP_MS);
        }
      }
    }
    for (const p of this.players) {
      if (!p.connected) {
        consider(p.disconnectGraceEndsAt);
      }
    }
    if (this.emptySince !== null) {
      consider(this.emptySince + ROOM_EMPTY_CLEANUP_MS);
    }
    if (
      (this.phase === "WAITING" || this.phase === "POST_MATCH") &&
      this.lastActivityAt !== null
    ) {
      consider(this.lastActivityAt + ROOM_IDLE_CLEANUP_MS);
    }
    this.storage.scheduleAlarm(earliest);
  }

  private persist(): void {
    const state: PersistedRoomState = {
      phase: this.phase,
      matchPhase: this.matchPhase,
      round: this.round,
      totalRounds: this.totalRounds,
      initialPlayerCount: this.initialPlayerCount,
      phaseEndsAt: this.phaseEndsAt,
      sacrificedPlayerId: this.sacrificedPlayerId,
      winnerId: this.winnerId,
      endReason: this.endReason,
      feed: this.feed,
      players: this.players,
      activeCurses: this.activeCurses,
      entityMood: this.entityMood,
      previousRoundMood: this.previousRoundMood,
      copyState: this.copyEngine.serialize(),
      roundId: this.roundId,
      isSuddenDeath: this.isSuddenDeath,
      roundPublicMessages: this.roundPublicMessages,
      lastSpamMockeryAt: this.lastSpamMockeryAt,
      resolvingCapAt: this.resolvingCapAt,
      emptySince: this.emptySince,
      lastActivityAt: this.lastActivityAt,
      roundWhispers: this.roundWhispers,
      lastWhisperInterceptAt: this.lastWhisperInterceptAt,
      roundWhisperInterceptCount: this.roundWhisperInterceptCount,
      whisperFallbackTriggered: this.whisperFallbackTriggered,
      whisperFallbackAt: this.whisperFallbackAt,
      lastLeakedWhisper: this.lastLeakedWhisper,
      eliminations: this.eliminations,
      postMatchClosingBeat: this.postMatchClosingBeat,
    };
    this.storage.save(JSON.stringify(state));
  }
}
