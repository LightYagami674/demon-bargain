import {
  CHAT_COOLDOWN_MS,
  IN_MATCH_DISCONNECT_GRACE_MS,
  INITIAL_DOOM,
  MAX_CHAT_LENGTH,
  MAX_FEED_ITEMS,
  MAX_PLAYERS,
  MIN_CHAT_LENGTH,
  MIN_PLAYERS,
  PRESET_AVATARS,
  ROOM_EMPTY_CLEANUP_MS,
  ROOM_IDLE_CLEANUP_MS,
  ROUND_INTRO_MS,
  ROUND_RESOLVING_MS,
  SACRIFICE_REVEAL_MS,
  WAITING_DISCONNECT_GRACE_MS,
  getRoundDurationMs,
  softResetDoom,
  type PresetAvatarId,
} from "../shared/constants.js";
import {
  ClientMessageSchema,
  type ClientMessage,
  type ErrorCode,
  type FeedItem,
  type MatchEndReason,
  type MatchPhase,
  type PublicPlayer,
  type RoomPhase,
  type ServerMessage,
} from "../shared/protocol.js";

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
  emptySince?: number | null;
  lastActivityAt?: number | null;
}

export class RoomCore {
  private readonly roomCode: string;
  private readonly transport: RoomTransport;
  private readonly storage: RoomStorage;
  private readonly clock: () => number;
  private readonly generateId: () => string;

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
  private emptySince: number | null = null;
  private lastActivityAt: number | null = null;
  private connectionToPlayerId = new Map<string, string>();
  private playerIdToConnectionId = new Map<string, string>();

  constructor(options: RoomCoreOptions) {
    this.roomCode = options.roomCode;
    this.transport = options.transport;
    this.storage = options.storage;
    this.clock = options.clock ?? (() => Date.now());
    this.generateId = options.generateId ?? (() => crypto.randomUUID());

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
        }));
        this.emptySince = parsed.emptySince ?? null;
        this.lastActivityAt = parsed.lastActivityAt ?? null;
      } catch {
        // Ignore corrupted persisted state and start fresh
      }
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
    this.persist();
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
      case "leave_room":
        this.handleLeaveRoom(connectionId);
        return;
      default:
        this.sendError(
          connectionId,
          "INVALID_PAYLOAD",
          `Action "${msg.type}" is not available yet.`,
        );
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
        if (p.isHost) {
          this.transferHostFrom(p.id);
        }
        this.emitEntityAnnouncement(
          "SACRIFICE_DISCONNECT",
          `${p.name} abandoned the ritual and was claimed by the Entity.`,
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
      }
    }

    this.rescheduleAlarm();
  }

  private advanceMatchPhase(now: number): void {
    if (this.matchPhase === "ROUND_INTRO") {
      const livingCount = this.players.filter((p) => p.alive).length;
      this.matchPhase = "ROUND_ACTIVE";
      this.phaseEndsAt =
        now + getRoundDurationMs(livingCount, this.initialPlayerCount);
      this.persist();
      this.broadcastPhaseChanged(now);
      return;
    }

    if (this.matchPhase === "ROUND_ACTIVE") {
      this.matchPhase = "ROUND_RESOLVING";
      this.phaseEndsAt = now + ROUND_RESOLVING_MS;
      this.persist();
      this.broadcastPhaseChanged(now);
      return;
    }

    if (this.matchPhase === "ROUND_RESOLVING") {
      const living = this.players.filter((p) => p.alive);
      let victim: InternalPlayer | null = null;
      for (const candidate of living) {
        if (!victim || candidate.doom > victim.doom) {
          victim = candidate;
        }
      }
      if (victim) {
        victim.alive = false;
        this.sacrificedPlayerId = victim.id;
      }
      this.matchPhase = "SACRIFICE_REVEAL";
      this.phaseEndsAt = now + SACRIFICE_REVEAL_MS;
      this.persist();
      this.broadcastPhaseChanged(now);
      if (victim) {
        this.emitEntityAnnouncement(
          "SACRIFICE_REVEAL",
          `${victim.name} has been claimed by the Entity.`,
          now,
        );
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
      for (const p of living) {
        p.doom = softResetDoom(p.doom);
      }
      this.matchPhase = "ROUND_INTRO";
      this.phaseEndsAt = now + ROUND_INTRO_MS;
      this.persist();
      this.broadcastPhaseChanged(now);
      this.emitEntityAnnouncement(
        "ROUND_INTRO",
        `Round ${this.round} begins. The Entity turns its gaze upon you.`,
        now,
      );
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
    this.feed = [];
    this.phaseEndsAt = now + ROUND_INTRO_MS;

    for (const p of this.players) {
      p.alive = true;
      p.doom = INITIAL_DOOM;
      p.lastChatAt = null;
    }

    this.persist();
    this.rescheduleAlarm();
    this.broadcastPhaseChanged(now);
    this.emitEntityAnnouncement(
      "ROUND_INTRO",
      `Round 1 begins. The Entity turns its gaze upon you.`,
      now,
    );
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
    this.pushFeedItem({
      kind: "chat",
      id,
      playerId: player.id,
      playerName: player.name,
      avatarId: player.avatarId,
      text,
      timestamp: now,
    });
    this.persist();

    const payload: ServerMessage = {
      type: "chat_message",
      id,
      playerId: player.id,
      playerName: player.name,
      avatarId: player.avatarId,
      text,
      timestamp: now,
    };
    this.transport.broadcast(JSON.stringify(payload));
  }

  private handleLeaveRoom(connectionId: string): void {
    const player = this.getAuthenticatedPlayer(connectionId);
    if (!player) return;

    const wasLivingInMatch = this.phase === "IN_MATCH" && player.alive;
    if (wasLivingInMatch) {
      player.doom = 100;
      player.alive = false;
    }

    this.connectionToPlayerId.delete(connectionId);
    this.playerIdToConnectionId.delete(player.id);
    this.removePlayer(player.id);
    this.transport.close(connectionId, 1000, "Left Room");

    if (wasLivingInMatch) {
      const now = this.clock();
      this.emitEntityAnnouncement(
        "SACRIFICE_DISCONNECT",
        `${player.name} fled the ritual and was claimed by the Entity.`,
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
    this.phase = "POST_MATCH";
    this.matchPhase = null;
    this.phaseEndsAt = null;
    this.sacrificedPlayerId = null;
    this.winnerId = living[0]?.id ?? null;
    this.endReason = living.length === 1 ? "SURVIVOR" : "ALL_CLAIMED";
    this.lastActivityAt = now;
    this.persist();
    this.broadcastPhaseChanged(now);
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
      feed: this.feed,
      chatCooldownEndsAt,
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
      emptySince: this.emptySince,
      lastActivityAt: this.lastActivityAt,
    };
    this.storage.save(JSON.stringify(state));
  }
}
