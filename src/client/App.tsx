import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PRESET_AVATARS,
  generateRoomCode,
  isValidRoomCode,
  type PresetAvatarId,
} from "../shared/constants.js";
import {
  ServerMessageSchema,
  type ClientMessage,
  type ErrorCode,
  type PublicPlayer,
  type RoomPhase,
  type ServerMessage,
} from "../shared/protocol.js";
import {
  createPartyRoomSocket,
  type CreateRoomSocket,
  type RoomSocket,
} from "./socket.js";
import {
  clearRoomToken,
  getPreferredAvatar,
  getPreferredName,
  getRoomToken,
  setPreferredAvatar,
  setPreferredName,
  setRoomToken,
} from "./storage.js";

export interface AppProps {
  createSocket?: CreateRoomSocket;
}

type Route =
  | { kind: "landing" }
  | { kind: "room"; roomCode: string };

function parseRoute(pathname: string): Route {
  const match = /^\/room\/([a-zA-Z0-9]+)\/?$/.exec(pathname);
  if (match?.[1]) {
    return { kind: "room", roomCode: match[1].toUpperCase() };
  }
  return { kind: "landing" };
}

interface RoomSnapshotState {
  roomCode: string;
  phase: RoomPhase;
  selfPlayerId: string;
  players: PublicPlayer[];
  phaseEndsAt: number | null;
}

export function App({ createSocket = createPartyRoomSocket }: AppProps) {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname),
  );
  const [banner, setBanner] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string>(() =>
    getPreferredName(),
  );

  useEffect(() => {
    const onPopState = () => {
      setRoute(parseRoute(window.location.pathname));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = (path: string, nextBanner: string | null = null) => {
    window.history.pushState({}, "", path);
    setRoute(parseRoute(path));
    setBanner(nextBanner);
  };

  if (route.kind === "room") {
    return (
      <RoomView
        roomCode={route.roomCode}
        initialName={pendingName}
        createSocket={createSocket}
        onExit={(reason) => navigate("/", reason ?? null)}
      />
    );
  }

  return (
    <LandingView
      initialName={pendingName}
      banner={banner}
      onDismissBanner={() => setBanner(null)}
      onCreateRoom={(name) => {
        const trimmed = name.trim();
        setPendingName(trimmed);
        setPreferredName(trimmed);
        const code = generateRoomCode();
        navigate(`/room/${code}`);
      }}
      onJoinRoom={(name, code) => {
        const trimmed = name.trim();
        setPendingName(trimmed);
        setPreferredName(trimmed);
        navigate(`/room/${code.toUpperCase()}`);
      }}
    />
  );
}

interface LandingViewProps {
  initialName: string;
  banner: string | null;
  onDismissBanner: () => void;
  onCreateRoom: (name: string) => void;
  onJoinRoom: (name: string, code: string) => void;
}

function LandingView({
  initialName,
  banner,
  onDismissBanner,
  onCreateRoom,
  onJoinRoom,
}: LandingViewProps) {
  const [name, setName] = useState(initialName);
  const [joinCode, setJoinCode] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setValidationError("Enter a display name (1–16 characters).");
      return;
    }
    setValidationError(null);
    onCreateRoom(trimmed);
  };

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    const normalizedCode = joinCode.trim().toUpperCase();
    if (!trimmed) {
      setValidationError("Enter a display name (1–16 characters).");
      return;
    }
    if (!isValidRoomCode(normalizedCode)) {
      setValidationError(
        "Enter a valid 4-letter Room code (letters A–Z excluding I, O, L).",
      );
      return;
    }
    setValidationError(null);
    onJoinRoom(trimmed, normalizedCode);
  };

  return (
    <main className="min-h-dvh bg-[#09070a] text-zinc-100 flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-md space-y-6">
        <header className="text-center space-y-2">
          <p className="text-xs uppercase tracking-[0.35em] text-red-500/80 font-semibold">
            2–6 Players • Real-Time Horror Chat
          </p>
          <h1 className="text-4xl font-black tracking-tight text-zinc-50">
            DEMON BARGAIN
          </h1>
          <p className="text-sm text-zinc-400">
            Plead for your life. Betray your friends. Outlast the Entity.
          </p>
        </header>

        {banner && (
          <div
            role="alert"
            className="rounded-xl border border-red-800/70 bg-red-950/50 px-4 py-3 text-sm text-red-200 flex items-center justify-between gap-3"
          >
            <span>{banner}</span>
            <button
              type="button"
              onClick={onDismissBanner}
              className="text-xs uppercase tracking-wider text-red-300 hover:text-white"
            >
              Dismiss
            </button>
          </div>
        )}

        <section className="rounded-2xl border border-zinc-800/90 bg-zinc-950/90 p-5 space-y-5 shadow-2xl">
          <div className="space-y-1.5">
            <label
              htmlFor="display-name-input"
              className="block text-xs font-semibold uppercase tracking-wider text-zinc-400"
            >
              Display Name
            </label>
            <input
              id="display-name-input"
              type="text"
              maxLength={MAX_NAME_LENGTH}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name..."
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 text-base text-zinc-100 placeholder:text-zinc-500 focus:border-red-600 focus:outline-none"
            />
          </div>

          {validationError && (
            <p role="alert" className="text-xs text-red-400">
              {validationError}
            </p>
          )}

          <button
            type="button"
            onClick={handleCreate}
            className="w-full rounded-xl bg-red-700 hover:bg-red-600 active:bg-red-800 px-4 py-3 text-sm font-bold uppercase tracking-wider text-white transition-colors"
          >
            Create Room
          </button>

          <div className="relative flex items-center py-1">
            <div className="flex-grow border-t border-zinc-800" />
            <span className="mx-3 text-xs uppercase tracking-widest text-zinc-500">
              or join existing
            </span>
            <div className="flex-grow border-t border-zinc-800" />
          </div>

          <form onSubmit={handleJoin} className="flex gap-2">
            <input
              type="text"
              aria-label="Room Code"
              maxLength={4}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="CODE"
              className="w-28 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-center font-mono text-base uppercase tracking-[0.25em] text-zinc-100 placeholder:text-zinc-600 focus:border-red-600 focus:outline-none"
            />
            <button
              type="submit"
              className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 px-4 py-2.5 text-sm font-semibold uppercase tracking-wider text-zinc-100 transition-colors"
            >
              Join Room
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

interface RoomViewProps {
  roomCode: string;
  initialName: string;
  createSocket: CreateRoomSocket;
  onExit: (reason?: string) => void;
}

function RoomView({
  roomCode,
  initialName,
  createSocket,
  onExit,
}: RoomViewProps) {
  const [socketOpen, setSocketOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<RoomSnapshotState | null>(null);
  const [joinName, setJoinName] = useState<string>(
    () => initialName || getPreferredName(),
  );
  const [errorBanner, setErrorBanner] = useState<{
    code?: ErrorCode;
    message: string;
  } | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  const socketRef = useRef<RoomSocket | null>(null);
  const initialNameRef = useRef(initialName);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const sendMessage = (msg: ClientMessage) => {
    const sock = socketRef.current;
    if (!sock || sock.readyState !== 1) return;
    sock.send(JSON.stringify(msg));
  };

  useEffect(() => {
    if (!isValidRoomCode(roomCode)) {
      setErrorBanner({
        message: "Invalid Room code. Codes are 4 letters excluding I, O, and L.",
      });
      return;
    }

    const socket = createSocket(roomCode);
    socketRef.current = socket;

    const handleOpen = () => {
      setSocketOpen(true);
      const savedToken = getRoomToken(roomCode);
      if (savedToken) {
        socket.send(JSON.stringify({ type: "join", playerToken: savedToken }));
        return;
      }
      const autoName = initialNameRef.current.trim();
      if (autoName) {
        const preferredAvatar = getPreferredAvatar();
        const joinMsg: ClientMessage = {
          type: "join",
          name: autoName,
          ...(preferredAvatar ? { avatarId: preferredAvatar } : {}),
        };
        socket.send(JSON.stringify(joinMsg));
      }
    };

    const handleMessage = (event: { data: string }) => {
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }

      let msg: ServerMessage;
      if (import.meta.env.DEV) {
        const parsed = ServerMessageSchema.safeParse(raw);
        if (!parsed.success) {
          console.warn("Invalid ServerMessage received:", parsed.error);
          return;
        }
        msg = parsed.data;
      } else {
        msg = raw as ServerMessage;
      }

      switch (msg.type) {
        case "room_snapshot": {
          setRoomToken(roomCode, msg.playerToken);
          const me = msg.players.find((p) => p.id === msg.selfPlayerId);
          if (me) {
            setPreferredName(me.name);
            setPreferredAvatar(me.avatarId);
          }
          setErrorBanner(null);
          setSnapshot({
            roomCode: msg.roomCode,
            phase: msg.phase,
            selfPlayerId: msg.selfPlayerId,
            players: msg.players,
            phaseEndsAt: msg.phaseEndsAt,
          });
          break;
        }
        case "player_updated": {
          setSnapshot((prev) => {
            if (!prev) return prev;
            const me = msg.players.find((p) => p.id === prev.selfPlayerId);
            if (me) {
              setPreferredAvatar(me.avatarId);
            }
            return { ...prev, players: msg.players };
          });
          break;
        }
        case "kicked": {
          clearRoomToken(roomCode);
          socket.close();
          onExitRef.current(msg.reason);
          break;
        }
        case "error": {
          setErrorBanner({ code: msg.code, message: msg.message });
          break;
        }
      }
    };

    const handleClose = () => {
      setSocketOpen(false);
    };

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", handleClose);

    return () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("close", handleClose);
      socket.close();
      socketRef.current = null;
    };
  }, [roomCode, createSocket]);

  const selfPlayer = useMemo(
    () => snapshot?.players.find((p) => p.id === snapshot.selfPlayerId) ?? null,
    [snapshot],
  );

  const takenAvatarsByOthers = useMemo(() => {
    const set = new Set<PresetAvatarId>();
    if (!snapshot) return set;
    for (const p of snapshot.players) {
      if (p.id !== snapshot.selfPlayerId) {
        set.add(p.avatarId);
      }
    }
    return set;
  }, [snapshot]);

  const handleManualJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = joinName.trim();
    if (!trimmed) {
      setErrorBanner({ message: "Enter a display name (1–16 characters)." });
      return;
    }
    setPreferredName(trimmed);
    const preferredAvatar = getPreferredAvatar();
    sendMessage({
      type: "join",
      name: trimmed,
      ...(preferredAvatar ? { avatarId: preferredAvatar } : {}),
    });
  };

  const handleSwapAvatar = (avatarId: PresetAvatarId) => {
    setPreferredAvatar(avatarId);
    sendMessage({ type: "swap_avatar", avatarId });
  };

  const handleKick = (targetPlayerId: string) => {
    sendMessage({ type: "kick_player", targetPlayerId });
  };

  const handleLeave = () => {
    sendMessage({ type: "leave_room" });
    clearRoomToken(roomCode);
    socketRef.current?.close();
    onExit();
  };

  const handleCopyInvite = async () => {
    const url = `${window.location.origin}/room/${roomCode}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard API may be unavailable in non-HTTPS/test environments
    }
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  if (!snapshot) {
    return (
      <main className="min-h-dvh bg-[#09070a] text-zinc-100 flex flex-col items-center justify-center px-4 py-8">
        <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-widest text-zinc-500">
                Joining Room
              </p>
              <h1 className="font-mono text-2xl font-bold tracking-[0.2em] text-red-400">
                {roomCode}
              </h1>
            </div>
            <button
              type="button"
              onClick={() => onExit()}
              className="text-xs uppercase tracking-wider text-zinc-400 hover:text-zinc-200"
            >
              Back
            </button>
          </div>

          {errorBanner && (
            <div
              role="alert"
              className="rounded-xl border border-red-800/70 bg-red-950/50 px-4 py-3 text-sm text-red-200"
            >
              {errorBanner.message}
            </div>
          )}

          {isValidRoomCode(roomCode) &&
            errorBanner?.code !== "ROOM_LOCKED" &&
            errorBanner?.code !== "ROOM_FULL" && (
              <form onSubmit={handleManualJoin} className="space-y-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="join-room-name"
                    className="block text-xs font-semibold uppercase tracking-wider text-zinc-400"
                  >
                    Display Name
                  </label>
                  <input
                    id="join-room-name"
                    type="text"
                    maxLength={MAX_NAME_LENGTH}
                    value={joinName}
                    onChange={(e) => setJoinName(e.target.value)}
                    placeholder="Your name..."
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 text-base text-zinc-100 focus:border-red-600 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!socketOpen}
                  className="w-full rounded-xl bg-red-700 hover:bg-red-600 disabled:opacity-50 px-4 py-3 text-sm font-bold uppercase tracking-wider text-white"
                >
                  {socketOpen ? "Enter Room" : "Connecting..."}
                </button>
              </form>
            )}
        </div>
      </main>
    );
  }

  const canStartMatch =
    Boolean(selfPlayer?.isHost) &&
    snapshot.players.length >= MIN_PLAYERS &&
    snapshot.players.length <= MAX_PLAYERS;

  return (
    <main className="min-h-dvh bg-[#09070a] text-zinc-100 flex flex-col">
      <header className="sticky top-0 z-10 border-b border-zinc-800/80 bg-zinc-950/95 backdrop-blur px-4 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="rounded-lg border border-red-900/70 bg-red-950/50 px-2.5 py-1 font-mono text-sm font-bold tracking-[0.2em] text-red-300">
            {snapshot.roomCode}
          </span>
          <span className="text-xs text-zinc-400">
            {snapshot.players.length}/{MAX_PLAYERS} players
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopyInvite}
            className="rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-200 transition-colors"
          >
            {copiedLink ? "Copied!" : "Copy Invite Link"}
          </button>
          <button
            type="button"
            onClick={handleLeave}
            className="rounded-lg border border-zinc-800 hover:border-red-800/70 px-3 py-1.5 text-xs font-semibold text-zinc-400 hover:text-red-300 transition-colors"
          >
            Leave Room
          </button>
        </div>
      </header>

      <div className="flex-1 w-full max-w-md mx-auto px-4 py-5 space-y-6">
        {errorBanner && (
          <div
            role="alert"
            className="rounded-xl border border-red-800/70 bg-red-950/50 px-4 py-2.5 text-sm text-red-200 flex items-center justify-between gap-2"
          >
            <span>{errorBanner.message}</span>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="text-xs uppercase text-red-300"
            >
              Dismiss
            </button>
          </div>
        )}

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
            Gathered Souls
          </h2>
          <ul className="space-y-2">
            {snapshot.players.map((player) => {
              const avatar =
                PRESET_AVATARS.find((a) => a.id === player.avatarId) ??
                PRESET_AVATARS[0];
              const isSelf = player.id === snapshot.selfPlayerId;
              return (
                <li
                  key={player.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800/90 bg-zinc-950/90 px-3.5 py-2.5"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-lg bg-zinc-900"
                      style={{ borderColor: avatar.accent }}
                      aria-label={avatar.label}
                    >
                      {avatar.glyph}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-semibold text-zinc-100">
                          {player.name}
                        </span>
                        {isSelf && (
                          <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                            (you)
                          </span>
                        )}
                        {player.isHost && (
                          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
                            Host
                          </span>
                        )}
                      </div>
                      {!player.connected && (
                        <p className="text-xs text-amber-400/80">
                          Reconnecting...
                        </p>
                      )}
                    </div>
                  </div>

                  {selfPlayer?.isHost && !isSelf && (
                    <button
                      type="button"
                      onClick={() => handleKick(player.id)}
                      aria-label={`Kick ${player.name}`}
                      className="rounded-lg border border-red-900/60 bg-red-950/40 hover:bg-red-900/60 px-2.5 py-1 text-xs font-semibold text-red-300 transition-colors"
                    >
                      Kick
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {snapshot.phase === "WAITING" && (
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
              Choose Your Vessel
            </h2>
            <div className="grid grid-cols-4 gap-2">
              {PRESET_AVATARS.map((avatar) => {
                const isSelected = selfPlayer?.avatarId === avatar.id;
                const isTaken = takenAvatarsByOthers.has(avatar.id);
                return (
                  <button
                    key={avatar.id}
                    type="button"
                    disabled={isTaken}
                    aria-label={avatar.label}
                    aria-pressed={isSelected}
                    onClick={() => handleSwapAvatar(avatar.id)}
                    className={`flex flex-col items-center justify-center gap-1 rounded-xl border p-2.5 transition-colors ${
                      isSelected
                        ? "border-red-500 bg-red-950/40 text-white"
                        : isTaken
                          ? "border-zinc-900 bg-zinc-950/40 opacity-35 cursor-not-allowed"
                          : "border-zinc-800 bg-zinc-950 hover:border-zinc-600"
                    }`}
                  >
                    <span className="text-2xl leading-none">{avatar.glyph}</span>
                    <span className="text-[10px] text-zinc-400 truncate max-w-full">
                      {avatar.label.split(" ")[1] ?? avatar.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <footer className="pt-2">
          {selfPlayer?.isHost ? (
            <div className="space-y-2">
              <button
                type="button"
                disabled={!canStartMatch}
                onClick={() => sendMessage({ type: "start_match" })}
                className="w-full rounded-xl bg-red-700 hover:bg-red-600 disabled:bg-zinc-800 disabled:text-zinc-500 px-4 py-3 text-sm font-bold uppercase tracking-wider text-white transition-colors"
              >
                Start Match
              </button>
              {!canStartMatch && (
                <p className="text-center text-xs text-zinc-500">
                  Need at least {MIN_PLAYERS} players to begin the ritual.
                </p>
              )}
            </div>
          ) : (
            <p className="text-center text-xs uppercase tracking-widest text-zinc-500 py-3">
              Waiting for Host to start the Match...
            </p>
          )}
        </footer>
      </div>
    </main>
  );
}
