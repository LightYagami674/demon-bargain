import { z } from "zod";
import {
  MAX_NAME_LENGTH,
  MIN_NAME_LENGTH,
  PRESET_AVATAR_IDS,
} from "./constants.js";

export const RoomPhaseSchema = z.enum(["WAITING", "IN_MATCH", "POST_MATCH"]);
export type RoomPhase = z.infer<typeof RoomPhaseSchema>;

export const MatchPhaseSchema = z.enum([
  "ROUND_INTRO",
  "ROUND_ACTIVE",
  "ROUND_RESOLVING",
  "SACRIFICE_REVEAL",
]);
export type MatchPhase = z.infer<typeof MatchPhaseSchema>;

export const MatchEndReasonSchema = z.enum([
  "SURVIVOR",
  "ALL_CLAIMED",
  "JUDGE_ERROR",
]);
export type MatchEndReason = z.infer<typeof MatchEndReasonSchema>;

export const PresetAvatarIdSchema = z.enum(PRESET_AVATAR_IDS);

export const FeedItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("chat"),
    id: z.string(),
    playerId: z.string(),
    playerName: z.string(),
    avatarId: PresetAvatarIdSchema,
    text: z.string(),
    timestamp: z.number(),
    doomDelta: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal("entity"),
    id: z.string(),
    beatType: z.string(),
    text: z.string(),
    timestamp: z.number(),
  }),
]);
export type FeedItem = z.infer<typeof FeedItemSchema>;

export const ErrorCodeSchema = z.enum([
  "ROOM_FULL",
  "ROOM_LOCKED",
  "NAME_TAKEN",
  "AVATAR_TAKEN",
  "COOLDOWN_ACTIVE",
  "INVALID_CURSE_WORD",
  "DUPLICATE_CURSE",
  "NOT_HOST",
  "INVALID_PAYLOAD",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const PublicPlayerSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatarId: PresetAvatarIdSchema,
  isHost: z.boolean(),
  connected: z.boolean(),
  joinedAt: z.number(),
  alive: z.boolean(),
  doom: z.number().int().min(0).max(100),
});
export type PublicPlayer = z.infer<typeof PublicPlayerSchema>;

export const DisplayNameSchema = z
  .string()
  .trim()
  .min(MIN_NAME_LENGTH)
  .max(MAX_NAME_LENGTH);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("join"),
    playerToken: z.string().min(1).optional(),
    name: DisplayNameSchema.optional(),
    avatarId: PresetAvatarIdSchema.optional(),
  }),
  z.object({
    type: z.literal("swap_avatar"),
    avatarId: PresetAvatarIdSchema,
  }),
  z.object({
    type: z.literal("kick_player"),
    targetPlayerId: z.string().min(1),
  }),
  z.object({
    type: z.literal("start_match"),
  }),
  z.object({
    type: z.literal("send_chat"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("send_whisper"),
    targetPlayerId: z.string().min(1),
    text: z.string(),
  }),
  z.object({
    type: z.literal("cast_curse"),
    targetPlayerId: z.string().min(1),
    word: z.string(),
  }),
  z.object({
    type: z.literal("play_again"),
  }),
  z.object({
    type: z.literal("leave_room"),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("room_snapshot"),
    roomCode: z.string(),
    phase: RoomPhaseSchema,
    selfPlayerId: z.string(),
    playerToken: z.string(),
    players: z.array(PublicPlayerSchema),
    serverNow: z.number(),
    phaseEndsAt: z.number().nullable(),
    matchPhase: MatchPhaseSchema.nullable().optional(),
    round: z.number().int().min(0).optional(),
    totalRounds: z.number().int().min(0).optional(),
    sacrificedPlayerId: z.string().nullable().optional(),
    winnerId: z.string().nullable().optional(),
    endReason: MatchEndReasonSchema.nullable().optional(),
    feed: z.array(FeedItemSchema).optional(),
    chatCooldownEndsAt: z.number().nullable().optional(),
  }),
  z.object({
    type: z.literal("player_updated"),
    players: z.array(PublicPlayerSchema),
  }),
  z.object({
    type: z.literal("phase_changed"),
    phase: RoomPhaseSchema,
    matchPhase: MatchPhaseSchema.nullable(),
    round: z.number().int().min(0),
    totalRounds: z.number().int().min(0),
    serverNow: z.number(),
    phaseEndsAt: z.number().nullable(),
    players: z.array(PublicPlayerSchema),
    sacrificedPlayerId: z.string().nullable().optional(),
    winnerId: z.string().nullable().optional(),
    endReason: MatchEndReasonSchema.nullable().optional(),
  }),
  z.object({
    type: z.literal("chat_message"),
    id: z.string(),
    playerId: z.string(),
    playerName: z.string(),
    avatarId: PresetAvatarIdSchema,
    text: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("entity_announcement"),
    id: z.string(),
    beatType: z.string(),
    text: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("kicked"),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    code: ErrorCodeSchema,
    message: z.string(),
    retryAfterMs: z.number().int().positive().optional(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
