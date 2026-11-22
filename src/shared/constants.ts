export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ";
export const ROOM_CODE_LENGTH = 4;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

export const MIN_NAME_LENGTH = 1;
export const MAX_NAME_LENGTH = 16;

export const WAITING_DISCONNECT_GRACE_MS = 30_000;
export const IN_MATCH_DISCONNECT_GRACE_MS = 45_000;
export const ROOM_EMPTY_CLEANUP_MS = 15 * 60_000;
export const ROOM_IDLE_CLEANUP_MS = 60 * 60_000;

export const INITIAL_DOOM = 50;
export const ROUND_INTRO_MS = 3_500;
export const ROUND_RESOLVING_MS = 2_000;
export const ROUND_RESOLVING_MAX_MS = 3_000;
export const SACRIFICE_REVEAL_MS = 4_500;
export const MOOD_ROTATION_MS = 30_000;
export const SUDDEN_DEATH_DURATION_MS = 30_000;
export const SUDDEN_DEATH_CLAMP_DOOM = 95;
export const SPAM_MOCKERY_COOLDOWN_MS = 5_000;
export const RECENT_CONTEXT_LIMIT = 6;

export const CHAT_COOLDOWN_MS = 2_500;
export const MIN_CHAT_LENGTH = 2;
export const MAX_CHAT_LENGTH = 200;
export const MAX_FEED_ITEMS = 200;

export const WHISPER_COOLDOWN_MS = 2_500;
export const MIN_WHISPER_LENGTH = 1;
export const MAX_WHISPER_LENGTH = 160;
export const MIN_PLAYERS_FOR_WHISPERS = 3;
export const WHISPER_INTERCEPT_BATCH_SIZE = 4;
export const WHISPER_INTERCEPT_MIN_GAP_MS = 15_000;
export const WHISPER_INTERCEPT_FALLBACK_REMAINING_MS = 25_000;
export const WHISPER_INTERCEPT_CANDIDATE_LIMIT = 12;
export const WHISPER_INTERCEPT_DOOM_PENALTY = 8;

const ROUND_DURATION_BY_LIVING_MS: Record<number, number> = {
  6: 90_000,
  5: 75_000,
  4: 65_000,
  3: 55_000,
  2: 45_000,
};

export function getRoundDurationMs(
  livingCount: number,
  initialPlayerCount: number,
): number {
  if (initialPlayerCount <= 2) {
    return 60_000;
  }
  return ROUND_DURATION_BY_LIVING_MS[livingCount] ?? 45_000;
}

export function softResetDoom(currentDoom: number): number {
  return Math.round((currentDoom + INITIAL_DOOM) / 2);
}

export function doomColor(pct: number): string {
  if (pct >= 80) return "#f43f5e";
  if (pct >= 50) return "#f59e0b";
  return "#22c55e";
}

export const PRESET_AVATARS = [
  { id: "skull", label: "Hollow Skull", glyph: "💀", accent: "#ef4444" },
  { id: "raven", label: "Carrion Crow", glyph: "🐦‍⬛", accent: "#a855f7" },
  { id: "moth", label: "Death's-Head Moth", glyph: "🦋", accent: "#f59e0b" },
  { id: "chalice", label: "Blood Chalice", glyph: "🍷", accent: "#dc2626" },
  { id: "dagger", label: "Ritual Blade", glyph: "🗡️", accent: "#94a3b8" },
  { id: "lantern", label: "Pale Lantern", glyph: "🕯️", accent: "#eab308" },
  { id: "serpent", label: "Ash Serpent", glyph: "🐍", accent: "#10b981" },
  { id: "crown", label: "Bramble Crown", glyph: "👑", accent: "#ec4899" },
] as const;

export type PresetAvatar = (typeof PRESET_AVATARS)[number];
export type PresetAvatarId = PresetAvatar["id"];

export const PRESET_AVATAR_IDS = PRESET_AVATARS.map((a) => a.id) as [
  PresetAvatarId,
  ...PresetAvatarId[],
];

export function generateRoomCode(random: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const idx = Math.floor(random() * ROOM_CODE_ALPHABET.length);
    code += ROOM_CODE_ALPHABET[idx] ?? ROOM_CODE_ALPHABET[0];
  }
  return code;
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (let i = 0; i < code.length; i++) {
    if (!ROOM_CODE_ALPHABET.includes(code[i] ?? "")) return false;
  }
  return true;
}
