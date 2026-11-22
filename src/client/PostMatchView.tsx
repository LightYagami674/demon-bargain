import { useState } from "react";
import { PRESET_AVATARS } from "../shared/constants.js";
import type {
  EliminationCause,
  FeedItem,
  MatchEndReason,
  PostMatchSummary,
  PublicPlayer,
} from "../shared/protocol.js";

const CAUSE_LABEL: Record<EliminationCause, string> = {
  TIMER: "Claimed by Doom",
  SPIKE: "100% Doom Spike",
  TIEBREAK: "Entity Tiebreak",
  DISCONNECT: "Abandoned",
};

interface PostMatchViewProps {
  roomCode: string;
  players: PublicPlayer[];
  selfPlayerId: string;
  winnerId: string | null;
  endReason: MatchEndReason | null;
  postMatchSummary: PostMatchSummary | null;
  feed: FeedItem[];
  reconnecting: boolean;
  onPlayAgain: () => void;
  onLeave: () => void;
}

export function PostMatchView({
  roomCode,
  players,
  selfPlayerId,
  winnerId,
  endReason,
  postMatchSummary,
  feed,
  reconnecting,
  onPlayAgain,
  onLeave,
}: PostMatchViewProps) {
  const [logOpen, setLogOpen] = useState(false);

  const selfPlayer = players.find((p) => p.id === selfPlayerId) ?? null;
  const resolvedEndReason = postMatchSummary?.endReason ?? endReason;
  const resolvedWinnerId = postMatchSummary?.winnerId ?? winnerId;
  const winnerPlayer = resolvedWinnerId
    ? (players.find((p) => p.id === resolvedWinnerId) ?? null)
    : null;
  const winnerAvatar = winnerPlayer
    ? PRESET_AVATARS.find((a) => a.id === winnerPlayer.avatarId)
    : null;

  const closingBeat =
    postMatchSummary?.closingBeat ??
    (resolvedEndReason === "JUDGE_ERROR"
      ? "The Entity fell silent — Match aborted"
      : resolvedEndReason === "SURVIVOR" && winnerPlayer
        ? `${winnerPlayer.name} survived the Entity.`
        : "All souls were claimed.");

  const eliminations = postMatchSummary?.eliminations ?? [];
  const awards = postMatchSummary?.awards ?? [];
  const publicLogItems = feed.filter((item) => item.kind !== "whisper");

  return (
    <main
      data-testid="post-match-screen"
      className="h-dvh bg-[#09070a] text-zinc-100 flex flex-col overflow-hidden"
    >
      <header className="shrink-0 border-b border-zinc-800/80 bg-zinc-950/95 px-4 py-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-lg border border-red-900/70 bg-red-950/50 px-2.5 py-0.5 font-mono text-xs font-bold tracking-[0.2em] text-red-300">
            {roomCode}
          </span>
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Post-Match
          </span>
          {reconnecting && (
            <span className="text-[11px] text-amber-300">Reconnecting...</span>
          )}
        </div>
        <button
          type="button"
          onClick={onLeave}
          className="rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-200"
        >
          Leave Room
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3 max-w-md w-full mx-auto">
        {resolvedEndReason === "JUDGE_ERROR" ? (
          <section className="rounded-2xl border border-red-700/70 bg-red-950/50 p-3.5 text-center space-y-1">
            <p className="text-[11px] font-bold uppercase tracking-widest text-red-300">
              Match Aborted
            </p>
            <p className="text-sm font-semibold text-red-100">{closingBeat}</p>
          </section>
        ) : resolvedEndReason === "SURVIVOR" && winnerPlayer ? (
          <section
            data-testid="survivor-spotlight"
            className="rounded-2xl border border-amber-600/60 bg-gradient-to-b from-amber-950/50 to-zinc-950/90 p-3.5 text-center space-y-1.5"
          >
            <p className="text-[11px] font-bold uppercase tracking-widest text-amber-300">
              Survivor Crowned
            </p>
            <div className="flex items-center justify-center gap-2">
              <span className="text-2xl">{winnerAvatar?.glyph ?? "💀"}</span>
              <span className="text-lg font-bold text-zinc-100">
                {winnerPlayer.name}
              </span>
            </div>
            <p className="text-xs italic text-rose-200/90">{closingBeat}</p>
          </section>
        ) : (
          <section className="rounded-2xl border border-rose-800/60 bg-rose-950/35 p-3.5 text-center space-y-1">
            <p className="text-[11px] font-bold uppercase tracking-widest text-rose-300">
              All Souls Claimed
            </p>
            <p className="text-xs italic text-rose-100/90">{closingBeat}</p>
          </section>
        )}

        <section
          data-testid="elimination-timeline"
          className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-3 space-y-2"
        >
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-zinc-400">
            Elimination Timeline
          </h2>
          {eliminations.length === 0 ? (
            <p className="text-xs text-zinc-500">
              No souls were claimed before the silence.
            </p>
          ) : (
            <ol className="space-y-1.5">
              {eliminations.map((ev, idx) => {
                const avatar = PRESET_AVATARS.find((a) => a.id === ev.avatarId);
                return (
                  <li
                    key={`${ev.round}-${ev.playerId}-${idx}`}
                    className="flex items-center justify-between gap-2 rounded-xl border border-zinc-800/80 bg-zinc-900/70 px-2.5 py-1.5 text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-[11px] text-zinc-400 shrink-0">
                        R{ev.round}
                      </span>
                      <span>{avatar?.glyph ?? "💀"}</span>
                      <span className="font-semibold text-zinc-100 truncate">
                        {ev.playerName}
                      </span>
                    </div>
                    <span className="text-[11px] text-rose-300 shrink-0">
                      {CAUSE_LABEL[ev.cause]}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {awards.length > 0 && (
          <section
            data-testid="post-match-awards"
            className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-3 space-y-2"
          >
            <h2 className="text-[11px] font-bold uppercase tracking-widest text-zinc-400">
              Awards
            </h2>
            <div className="space-y-1.5">
              {awards.map((award) => (
                <div
                  key={award.id}
                  className="rounded-xl border border-purple-900/50 bg-purple-950/25 px-3 py-2 space-y-0.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-purple-200">
                      {award.title}
                    </span>
                    <span className="text-xs font-semibold text-zinc-100">
                      {award.playerName}
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-300 break-words">
                    {award.detail}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-3 flex items-center justify-between gap-2">
          <span className="text-xs text-zinc-400">
            Live chat is locked
          </span>
          <button
            type="button"
            onClick={() => setLogOpen(true)}
            className="rounded-xl border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-100"
          >
            View Match Log
          </button>
        </section>
      </div>

      <footer className="shrink-0 border-t border-zinc-800/80 bg-zinc-950/95 px-4 py-3 max-w-md w-full mx-auto">
        {selfPlayer?.isHost ? (
          <button
            type="button"
            onClick={onPlayAgain}
            className="w-full rounded-xl bg-red-700 hover:bg-red-600 px-4 py-3 text-sm font-bold uppercase tracking-wider text-white"
          >
            Play Again
          </button>
        ) : (
          <p className="text-center text-xs text-zinc-400 py-1.5">
            Waiting for Host to start rematch...
          </p>
        )}
      </footer>

      {logOpen && (
        <div
          data-testid="match-log-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Match Log"
          className="fixed inset-0 z-50 bg-black/80 flex flex-col justify-end"
        >
          <div className="bg-[#0e0c12] border-t border-zinc-800 rounded-t-2xl max-h-[82dvh] flex flex-col max-w-md w-full mx-auto">
            <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-zinc-800">
              <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-200">
                Match Log (Read-Only)
              </h3>
              <button
                type="button"
                onClick={() => setLogOpen(false)}
                className="rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-200"
              >
                Close
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
              {publicLogItems.length === 0 ? (
                <p className="text-xs text-zinc-500 text-center py-6">
                  No public messages recorded in this Match.
                </p>
              ) : (
                publicLogItems.map((item) => {
                  if (item.kind === "entity") {
                    return (
                      <div
                        key={item.id}
                        className="rounded-xl border border-rose-600/50 bg-[#200a12]/95 px-3 py-2 text-xs italic text-rose-100"
                      >
                        {item.text}
                      </div>
                    );
                  }
                  if (item.kind === "whisper_intercepted") {
                    return (
                      <div
                        key={item.id}
                        className="rounded-xl border border-rose-500 bg-[#3a0c1e]/95 px-3 py-2 text-xs text-rose-100 space-y-1"
                      >
                        <p className="font-semibold italic text-rose-200">
                          {item.headerText}
                        </p>
                        <blockquote className="border-l-2 border-purple-400/70 pl-2 text-purple-100">
                          {item.whisperText}
                        </blockquote>
                      </div>
                    );
                  }
                  if (item.kind === "chat") {
                    return (
                      <div
                        key={item.id}
                        className="rounded-xl border border-zinc-800 bg-zinc-900/90 px-3 py-2 text-xs text-zinc-100"
                      >
                        <span className="font-bold text-zinc-300 mr-1.5">
                          {item.playerName}:
                        </span>
                        <span>{item.text}</span>
                      </div>
                    );
                  }
                  return null;
                })
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
