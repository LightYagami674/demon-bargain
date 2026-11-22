import {
  MAX_PLAYERS,
  PRESET_AVATARS,
  WAITING_DISCONNECT_GRACE_MS,
  type PresetAvatarId,
} from "../shared/constants.js";
import {
  ClientMessageSchema,
  type ClientMessage,
  type ErrorCode,
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
}

interface PersistedRoomState {
  phase: RoomPhase;
  phaseEndsAt: number | null;
  players: InternalPlayer[];
}

export class RoomCore {
  private readonly roomCode: string;
  private readonly transport: RoomTransport;
  private readonly storage: RoomStorage;
  private readonly clock: () => number;
  private readonly generateId: () => string;

  private phase: RoomPhase = "WAITING";
  private phaseEndsAt: number | null = null;
  private players: InternalPlayer[] = [];
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
        this.phaseEndsAt = parsed.phaseEndsAt;
        this.players = parsed.players;
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

  onClose(connectionId: string): void {
    const playerId = this.connectionToPlayerId.get(connectionId);
    if (!playerId) return;

    this.connectionToPlayerId.delete(connectionId);
    if (this.playerIdToConnectionId.get(playerId) === connectionId) {
      this.playerIdToConnectionId.delete(playerId);
    } else {
      // Connection was already superseded by a reconnect
      return;
    }

    const player = this.players.find((p) => p.id === playerId);
    if (!player) return;

    player.connected = false;
    if (this.phase === "WAITING" || this.phase === "POST_MATCH") {
      player.disconnectGraceEndsAt = this.clock() + WAITING_DISCONNECT_GRACE_MS;
    }

    this.persist();
    this.rescheduleAlarm();
    this.broadcastPlayers();
  }

  onAlarm(): void {
    const now = this.clock();
    let changed = false;

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
    }

    if (changed) {
      this.persist();
      this.broadcastPlayers();
    }
    this.rescheduleAlarm();
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
      doom: 50,
      disconnectGraceEndsAt: null,
    };

    this.players.push(player);
    this.attachConnection(connectionId, player);
    this.persist();
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
    this.persist();
    this.rescheduleAlarm();
    this.broadcastPlayers();
  }

  private handleLeaveRoom(connectionId: string): void {
    const player = this.getAuthenticatedPlayer(connectionId);
    if (!player) return;

    this.connectionToPlayerId.delete(connectionId);
    this.playerIdToConnectionId.delete(player.id);
    this.removePlayer(player.id);
    this.persist();
    this.rescheduleAlarm();
    this.transport.close(connectionId, 1000, "Left Room");
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
    this.send(connectionId, {
      type: "room_snapshot",
      roomCode: this.roomCode,
      phase: this.phase,
      selfPlayerId: recipient.id,
      playerToken: recipient.playerToken,
      players: this.toPublicPlayers(),
      serverNow: this.clock(),
      phaseEndsAt: this.phaseEndsAt,
    });
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

  private rescheduleAlarm(): void {
    let earliest: number | null = null;
    for (const p of this.players) {
      if (!p.connected && p.disconnectGraceEndsAt !== null) {
        if (earliest === null || p.disconnectGraceEndsAt < earliest) {
          earliest = p.disconnectGraceEndsAt;
        }
      }
    }
    this.storage.scheduleAlarm(earliest);
  }

  private persist(): void {
    const state: PersistedRoomState = {
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      players: this.players,
    };
    this.storage.save(JSON.stringify(state));
  }
}
