export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ";
export const ROOM_CODE_LENGTH = 4;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

export const MIN_NAME_LENGTH = 1;
export const MAX_NAME_LENGTH = 16;

export const WAITING_DISCONNECT_GRACE_MS = 30_000;

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
