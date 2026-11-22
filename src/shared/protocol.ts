import { z } from "zod";
import {
  MAX_NAME_LENGTH,
  MIN_NAME_LENGTH,
  PRESET_AVATAR_IDS,
} from "./constants.js";

export const RoomPhaseSchema = z.enum(["WAITING", "IN_MATCH", "POST_MATCH"]);
export type RoomPhase = z.infer<typeof RoomPhaseSchema>;

export const PresetAvatarIdSchema = z.enum(PRESET_AVATAR_IDS);

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
  }),
  z.object({
    type: z.literal("player_updated"),
    players: z.array(PublicPlayerSchema),
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
