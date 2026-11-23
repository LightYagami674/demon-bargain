export type LogLevel = "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface JsonLoggerOptions {
  sink?: (line: string, level: LogLevel) => void;
  now?: () => string;
}

const REDACTED_KEYS = new Set([
  "text",
  "messagetext",
  "playermessage",
  "recentcontext",
  "recentmessages",
  "whispertext",
  "whispers",
  "curseword",
  "activecurses",
  "playertoken",
  "token",
  "apikey",
  "typesafe_api_key",
  "cloudflare_api_token",
  "secret",
  "password",
  "authorization",
]);

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return undefined;
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) {
      continue;
    }
    const sanitized = sanitizeValue(val, depth + 1);
    if (sanitized !== undefined) {
      out[key] = sanitized;
    }
  }
  return out;
}

/**
 * Creates a structured single-line JSON logger for Cloudflare Workers Logs.
 * Strips sensitive keys (chat text, Whispers, Curse words, tokens, and secrets)
 * as defense-in-depth alongside caller-side omission.
 */
export function createJsonLogger(options: JsonLoggerOptions = {}): Logger {
  const sink =
    options.sink ??
    ((line: string, level: LogLevel) => {
      if (level === "error") {
        console.error(line);
      } else if (level === "warn") {
        console.warn(line);
      } else {
        console.log(line);
      }
    });
  const now = options.now ?? (() => new Date().toISOString());

  const emit = (level: LogLevel, event: string, fields?: LogFields) => {
    const sanitizedFields = fields
      ? (sanitizeValue(fields) as Record<string, unknown>)
      : {};
    const entry = {
      timestamp: now(),
      level,
      event,
      ...sanitizedFields,
    };
    sink(JSON.stringify(entry), level);
  };

  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}

export const NOOP_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
