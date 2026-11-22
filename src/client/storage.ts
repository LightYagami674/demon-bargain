import { PRESET_AVATARS, type PresetAvatarId } from "../shared/constants.js";

const PREFERRED_NAME_KEY = "demon-bargain:preferred-name";
const PREFERRED_AVATAR_KEY = "demon-bargain:preferred-avatar";
const ROOM_TOKEN_PREFIX = "demon-bargain:token:";
const AUDIO_MUTED_KEY = "demon-bargain:audio-muted";

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage quota or private mode errors
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

export function getPreferredName(): string {
  return safeGet(PREFERRED_NAME_KEY) ?? "";
}

export function setPreferredName(name: string): void {
  safeSet(PREFERRED_NAME_KEY, name);
}

export function getPreferredAvatar(): PresetAvatarId | undefined {
  const raw = safeGet(PREFERRED_AVATAR_KEY);
  if (!raw) return undefined;
  const match = PRESET_AVATARS.find((a) => a.id === raw);
  return match?.id;
}

export function setPreferredAvatar(avatarId: PresetAvatarId): void {
  safeSet(PREFERRED_AVATAR_KEY, avatarId);
}

export function getRoomToken(roomCode: string): string | null {
  return safeGet(`${ROOM_TOKEN_PREFIX}${roomCode.toUpperCase()}`);
}

export function setRoomToken(roomCode: string, token: string): void {
  safeSet(`${ROOM_TOKEN_PREFIX}${roomCode.toUpperCase()}`, token);
}

export function clearRoomToken(roomCode: string): void {
  safeRemove(`${ROOM_TOKEN_PREFIX}${roomCode.toUpperCase()}`);
}

export function getAudioMuted(): boolean {
  return safeGet(AUDIO_MUTED_KEY) === "true";
}

export function setAudioMuted(muted: boolean): void {
  safeSet(AUDIO_MUTED_KEY, muted ? "true" : "false");
}
