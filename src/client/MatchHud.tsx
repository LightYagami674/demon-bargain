import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  CHAT_COOLDOWN_MS,
  MAX_CHAT_LENGTH,
  MIN_CHAT_LENGTH,
  PRESET_AVATARS,
  doomColor,
} from "../shared/constants.js";
import type {
  ErrorCode,
  FeedItem,
  MatchEndReason,
  MatchPhase,
  PublicPlayer,
  RoomPhase,
} from "../shared/protocol.js";
import { computeDoomFxVars, drawEntityEyeFrame } from "./doomFx.js";
import { SoundEngine, type SoundEngineStatus } from "./audio/soundEngine.js";
import { getAudioMuted, setAudioMuted } from "./storage.js";

const RING_RADIUS = 16;
const RING_CIRC = 2 * Math.PI * RING_RADIUS;

export interface MatchHudProps {
  roomCode: string;
  phase: Extract<RoomPhase, "IN_MATCH" | "POST_MATCH">;
  matchPhase: MatchPhase | null;
  round: number;
  totalRounds: number;
  phaseEndsAt: number | null;
  clockOffsetMs: number;
  players: PublicPlayer[];
  selfPlayerId: string;
  sacrificedPlayerId: string | null;
  winnerId: string | null;
  endReason: MatchEndReason | null;
  feed: FeedItem[];
  serverCooldownEndsAt: number | null;
  errorBanner: { code?: ErrorCode; message: string } | null;
  onDismissError: () => void;
  onSendChat: (text: string) => void;
  onLeave: () => void;
}

function formatCountdown(
  phaseEndsAt: number | null,
  clockOffsetMs: number,
  nowMs: number,
): { text: string; urgent: boolean } {
  if (phaseEndsAt === null) {
    return { text: "--:--", urgent: false };
  }
  const remainingSec = Math.max(
    0,
    Math.ceil((phaseEndsAt - (nowMs + clockOffsetMs)) / 1000),
  );
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  return {
    text: `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`,
    urgent: remainingSec <= 15,
  };
}

export function MatchHud({
  roomCode,
  phase,
  matchPhase,
  round,
  totalRounds,
  phaseEndsAt,
  clockOffsetMs,
  players,
  selfPlayerId,
  sacrificedPlayerId,
  winnerId,
  endReason,
  feed,
  serverCooldownEndsAt,
  errorBanner,
  onDismissError,
  onSendChat,
  onLeave,
}: MatchHudProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [draft, setDraft] = useState("");
  const [localCooldownEndsAt, setLocalCooldownEndsAt] = useState<number>(0);
  const [validationNote, setValidationNote] = useState<string | null>(null);
  const [impactNow, setImpactNow] = useState(false);
  const [staticFlashActive, setStaticFlashActive] = useState(false);
  const feedEndRef = useRef<HTMLDivElement | null>(null);
  const eyeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const soundEngineRef = useRef<SoundEngine | null>(null);
  const prevFeedLenRef = useRef<number>(feed.length);
  const prevDoomRef = useRef<number | null>(null);
  const impactTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [audioStatus, setAudioStatus] = useState<SoundEngineStatus>(() => ({
    unlocked: false,
    muted: getAudioMuted(),
    contextState: "uninitialized",
    bpm: 65,
    droneGain: 0,
  }));

  useEffect(() => {
    const engine = new SoundEngine({
      initialMuted: getAudioMuted(),
      onStateChange: (status) => setAudioStatus(status),
    });
    soundEngineRef.current = engine;

    const unlockOnGesture = (e: Event) => {
      if (
        (e.target as HTMLElement | null)?.closest?.(
          '[data-testid="audio-toggle-btn"]',
        )
      ) {
        return;
      }
      void engine.unlock();
    };
    window.addEventListener("pointerdown", unlockOnGesture, { once: true });
    window.addEventListener("keydown", unlockOnGesture, { once: true });

    return () => {
      window.removeEventListener("pointerdown", unlockOnGesture);
      window.removeEventListener("keydown", unlockOnGesture);
      engine.destroy();
      soundEngineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [feed.length]);

  const selfPlayer = players.find((p) => p.id === selfPlayerId) ?? null;
  const selfDoom = selfPlayer?.doom ?? 0;
  const isAlive = selfPlayer?.alive ?? false;
  const effectiveDoom = isAlive ? selfDoom : 0;
  const bpm = Math.round(65 + (effectiveDoom / 100) * 90);
  const fx = computeDoomFxVars(effectiveDoom, bpm);

  useEffect(() => {
    soundEngineRef.current?.setDoom(effectiveDoom);
  }, [effectiveDoom]);

  const triggerImpact = () => {
    setImpactNow(true);
    setStaticFlashActive(true);
    soundEngineRef.current?.triggerStaticBurst(0.28);

    if (impactTimerRef.current) clearTimeout(impactTimerRef.current);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);

    flashTimerRef.current = setTimeout(() => {
      setStaticFlashActive(false);
    }, 190);
    impactTimerRef.current = setTimeout(() => {
      setImpactNow(false);
    }, 380);
  };

  useEffect(() => {
    return () => {
      if (impactTimerRef.current) clearTimeout(impactTimerRef.current);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const prevLen = prevFeedLenRef.current;
    prevFeedLenRef.current = feed.length;
    if (feed.length <= prevLen) return;

    const newItems = feed.slice(prevLen);
    const hasShockBeat = newItems.some(
      (item) =>
        item.kind === "entity" &&
        /whisper|leak|intercept|curse/i.test(item.beatType),
    );
    if (hasShockBeat) {
      triggerImpact();
    }
  }, [feed]);

  useEffect(() => {
    const prevDoom = prevDoomRef.current;
    prevDoomRef.current = effectiveDoom;
    if (prevDoom !== null && effectiveDoom - prevDoom >= 15) {
      triggerImpact();
    }
  }, [effectiveDoom]);

  const handleAudioToggle = () => {
    const engine = soundEngineRef.current;
    if (!engine) return;
    if (!engine.getStatus().unlocked) {
      void engine.unlock();
      return;
    }
    const nextMuted = engine.toggleMute();
    setAudioMuted(nextMuted);
  };

  useEffect(() => {
    const canvas = eyeCanvasRef.current;
    if (!canvas) return;
    if (effectiveDoom < 80) {
      if (canvas.width > 0) {
        canvas.width = 0;
      }
      return;
    }
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return;

    let rafId = 0;
    let eyePhase = 0;
    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
      }
      eyePhase += 0.025;
      drawEntityEyeFrame(ctx, canvas.width, canvas.height, eyePhase);
      rafId = window.requestAnimationFrame(render);
    };
    rafId = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(rafId);
  }, [effectiveDoom >= 80]);

  const canSpeak =
    phase === "IN_MATCH" && matchPhase === "ROUND_ACTIVE" && isAlive;

  const effectiveCooldownEndsAt = Math.max(
    localCooldownEndsAt,
    serverCooldownEndsAt !== null ? serverCooldownEndsAt - clockOffsetMs : 0,
  );
  const cooldownRemainingMs = Math.max(0, effectiveCooldownEndsAt - nowMs);
  const inCooldown = cooldownRemainingMs > 0;

  const countdown = formatCountdown(phaseEndsAt, clockOffsetMs, nowMs);

  const sacrificedPlayer = sacrificedPlayerId
    ? players.find((p) => p.id === sacrificedPlayerId) ?? null
    : null;
  const winnerPlayer = winnerId
    ? players.find((p) => p.id === winnerId) ?? null
    : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSpeak) return;
    if (inCooldown) {
      setValidationNote(
        `Wait ${Math.ceil(cooldownRemainingMs / 1000)}s before pleading again.`,
      );
      return;
    }
    const trimmed = draft.trim();
    if (trimmed.length < MIN_CHAT_LENGTH || trimmed.length > MAX_CHAT_LENGTH) {
      setValidationNote(
        `Plea must be ${MIN_CHAT_LENGTH}–${MAX_CHAT_LENGTH} characters.`,
      );
      return;
    }
    setValidationNote(null);
    setLocalCooldownEndsAt(Date.now() + CHAT_COOLDOWN_MS);
    setDraft("");
    onSendChat(trimmed);
  };

  let placeholder = "Plead for your life...";
  if (phase === "POST_MATCH") {
    placeholder = "Match concluded — chat is sealed";
  } else if (!isAlive) {
    placeholder = "You are a Ghost — public pleading is sealed";
  } else if (matchPhase !== "ROUND_ACTIVE") {
    placeholder = "Chat unlocks when the round begins...";
  }

  const fxStyle = {
    "--doom": String(effectiveDoom),
    "--desat": String(fx.desat),
    "--vignette-opacity": String(fx.vignetteOpacity),
    "--eye-opacity": String(fx.eyeOpacity),
    "--pulse-ms": `${fx.pulseMs}ms`,
  } as CSSProperties;

  return (
    <div
      data-testid="app-viewport"
      className={`app-viewport h-dvh flex flex-col bg-[#09090d] text-[#f4f4f7] overflow-hidden relative ${fx.tierClass} ${impactNow ? "impact-now" : ""}`}
      style={fxStyle}
      data-doom={selfDoom}
      data-match-phase={matchPhase ?? ""}
      data-alive={isAlive ? "true" : "false"}
    >
      <canvas
        ref={eyeCanvasRef}
        data-testid="doom-eye-canvas"
        className="doom-eye-canvas pointer-events-none"
        aria-hidden="true"
      />
      <div
        data-testid="doom-vignette"
        className="doom-vignette pointer-events-none"
        aria-hidden="true"
      />
      <div
        data-testid="static-flash"
        className={`static-flash pointer-events-none ${staticFlashActive ? "active" : ""}`}
        aria-hidden="true"
      />
      <header className="hud-header degrade-target shrink-0 z-10 flex items-center justify-between gap-2 px-3 py-2 bg-[#0e0e14]/95 border-b border-[#282838]">
        <div className="flex items-center gap-2">
          <span className="room-pill rounded-lg border border-red-900/70 bg-red-950/50 px-2 py-0.5 font-mono text-xs font-bold tracking-[0.18em] text-red-300">
            {roomCode}
          </span>
          {phase === "IN_MATCH" && (
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              R{round}/{totalRounds}
            </span>
          )}
        </div>

        <div
          data-testid="hud-timer"
          className={`timer-badge rounded-full border px-3 py-0.5 font-mono text-[15px] font-extrabold tracking-wider ${
            countdown.urgent
              ? "urgent border-rose-500 bg-rose-950/50 text-rose-200"
              : "border-rose-500/45 bg-zinc-900/90 text-zinc-100"
          }`}
        >
          {countdown.text}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-testid="audio-toggle-btn"
            onClick={handleAudioToggle}
            aria-label={
              !audioStatus.unlocked
                ? "Unlock audio"
                : audioStatus.muted
                  ? "Unmute audio"
                  : "Mute audio"
            }
            className="icon-btn rounded-lg border border-zinc-800 hover:border-rose-700/70 px-2 py-1 font-mono text-[11px] font-semibold text-zinc-300 hover:text-rose-200 transition-colors"
          >
            {!audioStatus.unlocked
              ? "🔇 Unlock"
              : audioStatus.muted
                ? "🔇 Muted"
                : `🔊 ${audioStatus.bpm}`}
          </button>
          <button
            type="button"
            onClick={onLeave}
            className="rounded-lg border border-zinc-800 hover:border-red-800/70 px-2.5 py-1 text-[11px] font-semibold text-zinc-400 hover:text-red-300 transition-colors"
          >
            Leave
          </button>
        </div>
      </header>

      <div className="vb-body flex-1 min-h-0 flex overflow-hidden">
        <aside
          data-testid="player-rail"
          className="vb-rail degrade-target w-[62px] shrink-0 bg-[#0d0d13]/95 border-r border-[#282838] py-1.5 px-1 flex flex-col items-center gap-1.5 overflow-y-auto z-[12]"
        >
          {players.map((p) => {
            const avatar =
              PRESET_AVATARS.find((a) => a.id === p.avatarId) ??
              PRESET_AVATARS[0];
            const isSelf = p.id === selfPlayerId;
            const ringColor = p.alive ? doomColor(p.doom) : "#52525b";
            const dashOffset = RING_CIRC * (1 - p.doom / 100);

            return (
              <div
                key={p.id}
                className={`vb-node w-[52px] py-1 px-0.5 rounded-[10px] border border-transparent flex flex-col items-center gap-0.5 ${
                  !p.alive ? "ghost opacity-45" : ""
                } ${isSelf ? "bg-zinc-900/70" : ""}`}
              >
                <div className="vb-ring-wrap relative w-[38px] h-[38px] flex items-center justify-center">
                  <svg
                    width="38"
                    height="38"
                    viewBox="0 0 38 38"
                    className="-rotate-90"
                    aria-hidden="true"
                  >
                    <circle
                      cx="19"
                      cy="19"
                      r={RING_RADIUS}
                      fill="none"
                      stroke="#242433"
                      strokeWidth="3"
                    />
                    <circle
                      cx="19"
                      cy="19"
                      r={RING_RADIUS}
                      fill="none"
                      stroke={ringColor}
                      strokeWidth="3"
                      strokeDasharray={RING_CIRC}
                      strokeDashoffset={dashOffset}
                      strokeLinecap="round"
                    />
                  </svg>
                  <span className="vb-emoji absolute text-base leading-none z-[2]">
                    {p.alive ? avatar.glyph : "👻"}
                  </span>
                </div>
                <span
                  className="vb-pct-tag font-mono text-[9.5px] font-extrabold leading-none"
                  style={{ color: p.alive ? doomColor(p.doom) : "#a1a1aa" }}
                >
                  {p.alive ? `${p.doom}%` : "GHOST"}
                </span>
                <span className="vb-name text-[9.5px] text-zinc-300 truncate max-w-[50px]">
                  {p.name}
                </span>
              </div>
            );
          })}
        </aside>

        <section className="flex-1 min-w-0 flex flex-col relative">
          {phase === "IN_MATCH" && matchPhase !== "ROUND_ACTIVE" && (
            <div className="shrink-0 z-[19] border-b border-red-900/50 bg-red-950/60 px-3 py-2 text-center text-xs font-semibold uppercase tracking-wider text-red-200">
              {matchPhase === "ROUND_INTRO" &&
                `Round ${round} — The Entity Awakens`}
              {matchPhase === "ROUND_RESOLVING" &&
                "The Entity Deliberates..."}
              {matchPhase === "SACRIFICE_REVEAL" &&
                (sacrificedPlayer
                  ? `Sacrifice Claimed: ${sacrificedPlayer.name}`
                  : "No soul was claimed")}
            </div>
          )}

          {phase === "POST_MATCH" && (
            <div className="shrink-0 z-[19] border-b border-amber-700/50 bg-amber-950/50 px-3 py-2.5 text-center space-y-0.5">
              <p className="text-xs font-bold uppercase tracking-widest text-amber-300">
                Match Over
              </p>
              <p className="text-sm font-semibold text-zinc-100">
                {endReason === "SURVIVOR" && winnerPlayer
                  ? `${winnerPlayer.name} survived the Entity.`
                  : "All souls were claimed."}
              </p>
            </div>
          )}

          {errorBanner && (
            <div
              role="alert"
              className="shrink-0 z-[19] border-b border-red-800/70 bg-red-950/80 px-3 py-1.5 text-xs text-red-200 flex items-center justify-between gap-2"
            >
              <span>{errorBanner.message}</span>
              <button
                type="button"
                onClick={onDismissError}
                className="uppercase tracking-wider text-red-300 hover:text-white"
              >
                Dismiss
              </button>
            </div>
          )}

          <div
            data-testid="chat-feed"
            className="chat-feed flex-1 min-h-0 overflow-y-auto px-3 py-2.5 flex flex-col gap-2 relative z-[18]"
          >
            {feed.length === 0 ? (
              <p className="text-xs text-zinc-500 text-center my-auto">
                The chamber is silent. Speak when the round begins.
              </p>
            ) : (
              feed.map((item) => {
                if (item.kind === "entity") {
                  return (
                    <div
                      key={item.id}
                      className="msg entity self-stretch rounded-xl border border-rose-600/55 bg-[#200a12]/95 px-3 py-2 text-[13.5px] leading-snug italic text-rose-100"
                    >
                      {item.text}
                    </div>
                  );
                }

                const isMine = item.playerId === selfPlayerId;
                return (
                  <div
                    key={item.id}
                    className={`msg max-w-[88%] rounded-xl border px-3 py-2 text-[13.5px] leading-snug ${
                      isMine
                        ? "mine self-end border-rose-600/35 bg-[#221826]/95 text-zinc-100"
                        : "self-start border-zinc-800 bg-[#161620]/95 text-zinc-100"
                    }`}
                  >
                    <p className="text-[11px] font-bold text-zinc-400 mb-0.5">
                      {item.playerName}
                    </p>
                    <p className="break-words">{item.text}</p>
                  </div>
                );
              })
            )}
            <div ref={feedEndRef} />
          </div>

          <form
            onSubmit={handleSubmit}
            className="composer-wrap shrink-0 z-[25] bg-[#0e0e14]/98 border-t border-[#282838] px-2.5 py-2 space-y-1"
          >
            {validationNote && (
              <p className="text-[11px] text-amber-300 px-1">{validationNote}</p>
            )}
            <div className="flex items-center gap-2">
              <input
                type="text"
                disabled={!canSpeak}
                maxLength={MAX_CHAT_LENGTH}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (validationNote) setValidationNote(null);
                }}
                placeholder={placeholder}
                className="composer-input flex-1 min-w-0 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-base text-zinc-100 placeholder:text-zinc-500 disabled:opacity-50 focus:border-rose-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!canSpeak}
                className="rounded-xl bg-rose-700 hover:bg-rose-600 disabled:bg-zinc-800 disabled:text-zinc-500 px-3.5 py-2 text-sm font-bold text-white transition-colors shrink-0"
              >
                {inCooldown
                  ? `${Math.ceil(cooldownRemainingMs / 1000)}s`
                  : "Send"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
