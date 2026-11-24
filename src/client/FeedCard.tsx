import type { FeedItem } from "../shared/protocol";

export interface MessageVerdict {
  delta: number;
  doom: number;
  blamedDeltas?: Array<{
    playerId: string;
    playerName: string;
    delta: number;
  }>;
}

export interface FeedCardProps {
  item: FeedItem;
  selfPlayerId?: string;
  compact?: boolean;
  judgePending?: boolean;
  verdict?: MessageVerdict;
}

/** Shared feed item card used by the live Match HUD and Post-Match log drawer. */
export function FeedCard({
  item,
  selfPlayerId,
  compact = false,
  judgePending = false,
  verdict,
}: FeedCardProps) {
  if (item.kind === "entity") {
    return (
      <div
        data-beat-type={item.beatType}
        className={
          compact
            ? "rounded-xl border border-rose-600/50 bg-[#200a12]/95 px-3 py-2 text-xs italic text-rose-100"
            : "msg entity self-stretch rounded-xl border border-rose-600/55 bg-[#200a12]/95 px-3 py-2 text-[13.5px] leading-snug italic text-rose-100"
        }
      >
        {item.text}
      </div>
    );
  }

  if (item.kind === "whisper") {
    if (compact) return null;
    const isMine = item.senderId === selfPlayerId;
    return (
      <div
        className={`msg whisper max-w-[88%] rounded-xl border border-dashed border-purple-500/65 bg-[#221030]/95 px-3 py-2 text-[13.5px] leading-snug text-purple-100 ${
          isMine ? "mine self-end" : "self-start"
        }`}
      >
        <p className="text-[11px] font-bold text-purple-300 mb-0.5">
          {isMine
            ? `Whisper to ${item.targetName}`
            : `Whisper from ${item.senderName}`}
        </p>
        <p className="break-words">{item.text}</p>
      </div>
    );
  }

  if (item.kind === "whisper_intercepted") {
    return (
      <div
        className={
          compact
            ? "rounded-xl border border-rose-500 bg-[#3a0c1e]/95 px-3 py-2 text-xs text-rose-100 space-y-1"
            : "msg intercepted self-stretch rounded-xl border border-rose-500 bg-[#3a0c1e]/95 px-3 py-2.5 text-[13.5px] leading-snug text-rose-100 space-y-1.5"
        }
      >
        <p className="font-semibold italic text-rose-200">{item.headerText}</p>
        <blockquote
          data-testid="intercepted-whisper-quote"
          className={
            compact
              ? "border-l-2 border-purple-400/70 pl-2 text-purple-100"
              : "border-l-2 border-purple-400/80 bg-black/35 rounded-r-lg px-2.5 py-1.5 text-purple-100 not-italic break-words"
          }
        >
          {item.whisperText}
        </blockquote>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/90 px-3 py-2 text-xs text-zinc-100">
        <span className="font-bold text-zinc-300 mr-1.5">
          {item.playerName}:
        </span>
        <span>{item.text}</span>
      </div>
    );
  }

  const isMine = item.playerId === selfPlayerId;
  return (
    <div
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
      {isMine && judgePending && (
        <div
          data-testid={`msg-judge-pending-${item.id}`}
          className="mt-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold text-amber-300/90"
        >
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 rounded-full border-[1.5px] border-amber-300/35 border-t-amber-300 animate-spin"
          />
          <span>Weighing plea...</span>
        </div>
      )}
      {isMine && !judgePending && verdict && (
        <div
          data-testid={`msg-judge-verdict-${item.id}`}
          className="mt-1.5 flex flex-wrap items-center gap-1"
        >
          <span
            className={`inline-flex items-center rounded-full border px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none ${
              verdict.delta > 0
                ? "border-rose-500/60 bg-rose-950/70 text-rose-200"
                : verdict.delta < 0
                  ? "border-emerald-500/60 bg-emerald-950/70 text-emerald-200"
                  : "border-zinc-600/70 bg-zinc-800/80 text-zinc-300"
            }`}
          >
            {verdict.delta > 0
              ? `▲ +${verdict.delta}% Doom`
              : verdict.delta < 0
                ? `▼ ${verdict.delta}% Doom`
                : "✓ 0% Doom"}
          </span>
          {verdict.blamedDeltas?.map((b) => (
            <span
              key={b.playerId}
              className="inline-flex items-center rounded-full border border-purple-500/50 bg-purple-950/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none text-purple-200"
            >
              {b.playerName} {b.delta > 0 ? `+${b.delta}%` : `${b.delta}%`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
