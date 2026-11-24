import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App.js";
import type { CreateRoomSocket, RoomSocket } from "./socket.js";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";
import { isValidRoomCode } from "../shared/constants.js";
import {
  getAudioMuted,
  getPreferredAvatar,
  getPreferredName,
  getRoomToken,
  setPreferredName,
  setRoomToken,
} from "./storage.js";

class FakeRoomSocket implements RoomSocket {
  readyState = 0; // CONNECTING
  sent: ClientMessage[] = [];
  closed = false;
  reconnectCount = 0;
  readonly roomCode: string;

  private openListeners = new Set<() => void>();
  private messageListeners = new Set<(event: { data: string }) => void>();
  private closeListeners = new Set<() => void>();
  private errorListeners = new Set<() => void>();

  constructor(roomCode: string) {
    this.roomCode = roomCode;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    for (const fn of this.closeListeners) fn();
  }

  reconnect(): void {
    this.reconnectCount += 1;
  }

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: string }) => void,
  ): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: string, listener: unknown): void {
    if (type === "open") this.openListeners.add(listener as () => void);
    if (type === "message")
      this.messageListeners.add(listener as (e: { data: string }) => void);
    if (type === "close") this.closeListeners.add(listener as () => void);
    if (type === "error") this.errorListeners.add(listener as () => void);
  }

  removeEventListener(type: "open", listener: () => void): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: string }) => void,
  ): void;
  removeEventListener(type: "close", listener: () => void): void;
  removeEventListener(type: "error", listener: () => void): void;
  removeEventListener(type: string, listener: unknown): void {
    if (type === "open") this.openListeners.delete(listener as () => void);
    if (type === "message")
      this.messageListeners.delete(listener as (e: { data: string }) => void);
    if (type === "close") this.closeListeners.delete(listener as () => void);
    if (type === "error") this.errorListeners.delete(listener as () => void);
  }

  emitOpen(): void {
    this.readyState = 1; // OPEN
    for (const fn of this.openListeners) fn();
  }

  emitServerMessage(message: ServerMessage): void {
    const raw = JSON.stringify(message);
    for (const fn of this.messageListeners) fn({ data: raw });
  }
}

describe("SPA Socket Seam — Room creation, join, avatar swap, kick, leave & reconnect", () => {
  let sockets: FakeRoomSocket[];
  let createSocket: CreateRoomSocket;

  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
    sockets = [];
    createSocket = (roomCode) => {
      const sock = new FakeRoomSocket(roomCode);
      sockets.push(sock);
      return sock;
    };
  });

  it("creates a Room with a valid 4-letter code, joins on socket open, persists identity/token, and exposes shareable link", async () => {
    const user = userEvent.setup();
    render(<App createSocket={createSocket} />);

    const nameInput = screen.getByLabelText(/display name/i);
    await user.type(nameInput, "Alice");
    await user.click(screen.getByRole("button", { name: /create room/i }));

    expect(sockets).toHaveLength(1);
    const sock = sockets[0]!;
    expect(isValidRoomCode(sock.roomCode)).toBe(true);
    expect(window.location.pathname).toBe(`/room/${sock.roomCode}`);

    act(() => {
      sock.emitOpen();
    });

    expect(sock.sent).toEqual([{ type: "join", name: "Alice" }]);

    act(() => {
      sock.emitServerMessage({
        type: "room_snapshot",
        roomCode: sock.roomCode,
        phase: "WAITING",
        selfPlayerId: "p1",
        playerToken: "tok-alice",
        serverNow: 1_700_000_000_000,
        phaseEndsAt: null,
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: 1_700_000_000_000,
            alive: true,
            doom: 50,
          },
        ],
      });
    });

    expect(screen.getByText(sock.roomCode)).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy invite link/i })).toBeInTheDocument();
    expect(getPreferredName()).toBe("Alice");
    expect(getPreferredAvatar()).toBe("skull");
    expect(getRoomToken(sock.roomCode)).toBe("tok-alice");
  });

  it("sends swap_avatar, persists preferred avatar, and lets Host kick another player", async () => {
    const user = userEvent.setup();
    setPreferredName("Alice");
    setRoomToken("WXYZ", "tok-alice");
    window.history.replaceState({}, "", "/room/WXYZ");

    render(<App createSocket={createSocket} />);
    const sock = sockets[0]!;

    act(() => {
      sock.emitOpen();
    });

    // Auto-reconnect uses saved room token
    expect(sock.sent).toEqual([{ type: "join", playerToken: "tok-alice" }]);

    act(() => {
      sock.emitServerMessage({
        type: "room_snapshot",
        roomCode: "WXYZ",
        phase: "WAITING",
        selfPlayerId: "p1",
        playerToken: "tok-alice",
        serverNow: 1_700_000_000_000,
        phaseEndsAt: null,
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: 1_700_000_000_000,
            alive: true,
            doom: 50,
          },
          {
            id: "p2",
            name: "Bob",
            avatarId: "raven",
            isHost: false,
            connected: true,
            joinedAt: 1_700_000_001_000,
            alive: true,
            doom: 50,
          },
        ],
      });
    });

    // Bob's avatar (Carrion Crow / raven) is disabled
    expect(screen.getByRole("button", { name: /carrion crow/i })).toBeDisabled();

    // Alice swaps to Bramble Crown (crown)
    await user.click(screen.getByRole("button", { name: /bramble crown/i }));
    expect(sock.sent[1]).toEqual({ type: "swap_avatar", avatarId: "crown" });

    // Host Alice kicks Bob
    await user.click(screen.getByRole("button", { name: /kick bob/i }));
    expect(sock.sent[2]).toEqual({ type: "kick_player", targetPlayerId: "p2" });
  });

  it("shows clear notification and returns to landing when kicked", () => {
    setRoomToken("WXYZ", "tok-bob");
    window.history.replaceState({}, "", "/room/WXYZ");

    render(<App createSocket={createSocket} />);
    const sock = sockets[0]!;

    act(() => {
      sock.emitOpen();
      sock.emitServerMessage({
        type: "kicked",
        reason: "You were removed from the Room by the Host.",
      });
    });

    expect(window.location.pathname).toBe("/");
    expect(getRoomToken("WXYZ")).toBeNull();
    expect(
      screen.getByText(/you were removed from the room by the host/i),
    ).toBeInTheDocument();
  });

  it("sends leave_room, clears Room token, and returns to landing on explicit Leave Room", async () => {
    const user = userEvent.setup();
    setRoomToken("WXYZ", "tok-alice");
    window.history.replaceState({}, "", "/room/WXYZ");

    render(<App createSocket={createSocket} />);
    const sock = sockets[0]!;

    act(() => {
      sock.emitOpen();
      sock.emitServerMessage({
        type: "room_snapshot",
        roomCode: "WXYZ",
        phase: "WAITING",
        selfPlayerId: "p1",
        playerToken: "tok-alice",
        serverNow: 1_700_000_000_000,
        phaseEndsAt: null,
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: 1_700_000_000_000,
            alive: true,
            doom: 50,
          },
        ],
      });
    });

    await user.click(screen.getByRole("button", { name: /leave room/i }));
    expect(sock.sent).toContainEqual({ type: "leave_room" });
    expect(getRoomToken("WXYZ")).toBeNull();
    expect(window.location.pathname).toBe("/");
  });
});

describe("SPA Socket Seam — Variant B Mobile HUD, clock-skew timer & live public pleading", () => {
  let sockets: FakeRoomSocket[];
  let createSocket: CreateRoomSocket;

  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
    sockets = [];
    createSocket = (roomCode) => {
      const sock = new FakeRoomSocket(roomCode);
      sockets.push(sock);
      return sock;
    };
  });

  it("transitions from WAITING to Variant B HUD with left rail SVG Doom rings, Ghost badges, and clock-skew-adjusted timer", async () => {
    const user = userEvent.setup();
    setRoomToken("WXYZ", "tok-alice");
    window.history.replaceState({}, "", "/room/WXYZ");

    render(<App createSocket={createSocket} />);
    const sock = sockets[0]!;

    const twoPlayers = [
      {
        id: "p1",
        name: "Alice",
        avatarId: "skull" as const,
        isHost: true,
        connected: true,
        joinedAt: 1_700_000_000_000,
        alive: true,
        doom: 50,
      },
      {
        id: "p2",
        name: "Bob",
        avatarId: "raven" as const,
        isHost: false,
        connected: true,
        joinedAt: 1_700_000_000_100,
        alive: true,
        doom: 50,
      },
    ];

    act(() => {
      sock.emitOpen();
      sock.emitServerMessage({
        type: "room_snapshot",
        roomCode: "WXYZ",
        phase: "WAITING",
        selfPlayerId: "p1",
        playerToken: "tok-alice",
        serverNow: Date.now(),
        phaseEndsAt: null,
        players: twoPlayers,
      });
    });

    await user.click(screen.getByRole("button", { name: /start match/i }));
    expect(sock.sent).toContainEqual({ type: "start_match" });

    // Server clock is +60s ahead of client Date.now() to verify skew adjustment
    const skewedServerNow = Date.now() + 60_000;
    act(() => {
      sock.emitServerMessage({
        type: "phase_changed",
        phase: "IN_MATCH",
        matchPhase: "ROUND_ACTIVE",
        round: 1,
        totalRounds: 1,
        serverNow: skewedServerNow,
        phaseEndsAt: skewedServerNow + 60_000,
        players: [
          { ...twoPlayers[0]!, doom: 82 },
          { ...twoPlayers[1]!, alive: false, doom: 100 },
        ],
      });
    });

    // Header shows Room code, round, and 01:00 timer (skew-adjusted, not 02:00)
    expect(screen.getByText("WXYZ")).toBeInTheDocument();
    expect(screen.getByTestId("hud-timer")).toHaveTextContent("01:00");

    // Left vertical rail renders SVG Doom rings and Ghost badge
    const rail = screen.getByTestId("player-rail");
    expect(rail).toHaveTextContent("Alice");
    expect(rail).toHaveTextContent("82%");
    expect(rail).toHaveTextContent("Bob");
    expect(rail).toHaveTextContent("GHOST");
    expect(rail.querySelectorAll("svg circle").length).toBeGreaterThanOrEqual(4);
  });

  it("enforces 2-200 char & 2.5s cooldown on public chat, renders chat & Entity announcements, and locks Ghost composer", async () => {
    const user = userEvent.setup();
    setRoomToken("WXYZ", "tok-alice");
    window.history.replaceState({}, "", "/room/WXYZ");

    render(<App createSocket={createSocket} />);
    const sock = sockets[0]!;
    const now = Date.now();

    act(() => {
      sock.emitOpen();
      sock.emitServerMessage({
        type: "room_snapshot",
        roomCode: "WXYZ",
        phase: "IN_MATCH",
        matchPhase: "ROUND_ACTIVE",
        round: 1,
        totalRounds: 1,
        selfPlayerId: "p1",
        playerToken: "tok-alice",
        serverNow: now,
        phaseEndsAt: now + 60_000,
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: now,
            alive: true,
            doom: 50,
          },
          {
            id: "p2",
            name: "Bob",
            avatarId: "raven",
            isHost: false,
            connected: true,
            joinedAt: now + 100,
            alive: true,
            doom: 50,
          },
        ],
        feed: [],
      });
    });

    const input = screen.getByPlaceholderText(/plead for your life/i);
    const sendBtn = screen.getByRole("button", { name: /send/i });

    // 1-char message is blocked client-side
    await user.type(input, "a");
    await user.click(sendBtn);
    expect(sock.sent.filter((m) => m.type === "send_chat")).toHaveLength(0);

    // Valid message sends immediately
    await user.type(input, "lmost certain Bob lied");
    await user.click(sendBtn);
    expect(sock.sent).toContainEqual({
      type: "send_chat",
      text: "almost certain Bob lied",
    });

    // Cooldown prevents immediate second send
    await user.type(input, "Second plea");
    await user.click(sendBtn);
    expect(sock.sent.filter((m) => m.type === "send_chat")).toHaveLength(1);

    // Server broadcasts chat_message and entity_announcement
    act(() => {
      sock.emitServerMessage({
        type: "chat_message",
        id: "m1",
        playerId: "p1",
        playerName: "Alice",
        avatarId: "skull",
        text: "almost certain Bob lied",
        timestamp: now + 500,
      });
      sock.emitServerMessage({
        type: "entity_announcement",
        id: "e1",
        beatType: "ROUND_INTRO",
        text: "Round 1 begins. The Entity turns its gaze upon you.",
        timestamp: now + 600,
      });
    });

    const feed = screen.getByTestId("chat-feed");
    expect(feed).toHaveTextContent("almost certain Bob lied");
    expect(feed).toHaveTextContent(
      "Round 1 begins. The Entity turns its gaze upon you.",
    );

    // Transition Alice to Ghost -> composer disabled
    act(() => {
      sock.emitServerMessage({
        type: "phase_changed",
        phase: "IN_MATCH",
        matchPhase: "SACRIFICE_REVEAL",
        round: 1,
        totalRounds: 1,
        serverNow: now + 60_000,
        phaseEndsAt: now + 64_500,
        sacrificedPlayerId: "p1",
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: now,
            alive: false,
            doom: 100,
          },
          {
            id: "p2",
            name: "Bob",
            avatarId: "raven",
            isHost: false,
            connected: true,
            joinedAt: now + 100,
            alive: true,
            doom: 50,
          },
        ],
      });
    });

    expect(
      screen.getByPlaceholderText(/ghost/i),
    ).toBeDisabled();
  });

  it("applies 50% and 80% Doom visual degradation states and clears them when eliminated", () => {
    const now = 1_700_000_000_000;
    setPreferredName("Alice");
    setRoomToken("ABCD", "tok-alice");
    window.history.replaceState({}, "", "/room/ABCD");

    render(<App createSocket={createSocket} />);
    const sock = sockets[0]!;

    act(() => {
      sock.emitOpen();
      sock.emitServerMessage({
        type: "room_snapshot",
        roomCode: "ABCD",
        phase: "IN_MATCH",
        matchPhase: "ROUND_ACTIVE",
        round: 1,
        totalRounds: 2,
        selfPlayerId: "p1",
        playerToken: "tok-alice",
        serverNow: now,
        phaseEndsAt: now + 60_000,
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: now,
            alive: true,
            doom: 49,
          },
          {
            id: "p2",
            name: "Bob",
            avatarId: "raven",
            isHost: false,
            connected: true,
            joinedAt: now + 100,
            alive: true,
            doom: 30,
          },
        ],
      });
    });

    const viewport = screen.getByTestId("app-viewport");
    expect(viewport).not.toHaveClass("doom-50");
    expect(viewport).not.toHaveClass("doom-80");
    expect(viewport.style.getPropertyValue("--desat")).toBe("0");
    expect(viewport.style.getPropertyValue("--vignette-opacity")).toBe("0");
    expect(viewport.style.getPropertyValue("--eye-opacity")).toBe("0");

    // 50%+ Doom: selective desaturation & micro-tremor, chat stays crisp
    act(() => {
      sock.emitServerMessage({
        type: "player_updated",
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: now,
            alive: true,
            doom: 65,
          },
          {
            id: "p2",
            name: "Bob",
            avatarId: "raven",
            isHost: false,
            connected: true,
            joinedAt: now + 100,
            alive: true,
            doom: 30,
          },
        ],
      });
    });

    expect(viewport).toHaveClass("doom-50");
    expect(viewport).not.toHaveClass("doom-80");
    expect(Number(viewport.style.getPropertyValue("--desat"))).toBeCloseTo(0.234, 3);
    expect(Number(viewport.style.getPropertyValue("--vignette-opacity"))).toBeCloseTo(0.345, 3);
    expect(viewport.style.getPropertyValue("--eye-opacity")).toBe("0");
    expect(screen.getByTestId("player-rail")).toHaveClass("degrade-target");
    expect(screen.getByTestId("chat-feed")).not.toHaveClass("degrade-target");

    // 80%+ Doom: Entity Eye canvas & crimson radial edge vignette activate
    act(() => {
      sock.emitServerMessage({
        type: "player_updated",
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: now,
            alive: true,
            doom: 80,
          },
          {
            id: "p2",
            name: "Bob",
            avatarId: "raven",
            isHost: false,
            connected: true,
            joinedAt: now + 100,
            alive: true,
            doom: 30,
          },
        ],
      });
    });

    expect(viewport).toHaveClass("doom-80");
    expect(viewport).not.toHaveClass("doom-50");
    expect(Number(viewport.style.getPropertyValue("--eye-opacity"))).toBeCloseTo(0.45, 3);
    expect(Number(viewport.style.getPropertyValue("--vignette-opacity"))).toBeCloseTo(0.62, 3);
    expect(screen.getByTestId("doom-eye-canvas")).toHaveClass("pointer-events-none");
    expect(screen.getByTestId("doom-vignette")).toHaveClass("pointer-events-none");

    // Eliminated Ghost clears Doom degradation
    act(() => {
      sock.emitServerMessage({
        type: "player_updated",
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: now,
            alive: false,
            doom: 100,
          },
          {
            id: "p2",
            name: "Bob",
            avatarId: "raven",
            isHost: false,
            connected: true,
            joinedAt: now + 100,
            alive: true,
            doom: 30,
          },
        ],
      });
    });

    expect(viewport).not.toHaveClass("doom-50");
    expect(viewport).not.toHaveClass("doom-80");
    expect(viewport.style.getPropertyValue("--eye-opacity")).toBe("0");
    expect(viewport.style.getPropertyValue("--vignette-opacity")).toBe("0");
  });

  describe("Audio unlock, persistent header mute toggle & static burst triggers", () => {
    let fakeCtx: {
      state: AudioContextState;
      currentTime: number;
      sampleRate: number;
      destination: Record<string, never>;
      resume: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      createGain: ReturnType<typeof vi.fn>;
      createOscillator: ReturnType<typeof vi.fn>;
      createBiquadFilter: ReturnType<typeof vi.fn>;
      createBuffer: ReturnType<typeof vi.fn>;
      createBufferSource: ReturnType<typeof vi.fn>;
      filters: Array<{ type: string; frequency: { value: number }; Q: { value: number } }>;
    };

    beforeEach(() => {
      const filters: Array<{ type: string; frequency: { value: number }; Q: { value: number } }> = [];
      fakeCtx = {
        state: "suspended",
        currentTime: 1,
        sampleRate: 44100,
        destination: {},
        filters,
        resume: vi.fn(async () => {
          fakeCtx.state = "running";
        }),
        close: vi.fn(async () => {
          fakeCtx.state = "closed";
        }),
        createGain: vi.fn(() => ({
          gain: {
            value: 1,
            setValueAtTime: vi.fn(),
            setTargetAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
        })),
        createOscillator: vi.fn(() => ({
          type: "sine",
          frequency: {
            value: 440,
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        })),
        createBiquadFilter: vi.fn(() => {
          const f = { type: "lowpass", frequency: { value: 350 }, Q: { value: 1 }, connect: vi.fn() };
          filters.push(f);
          return f;
        }),
        createBuffer: vi.fn((_c: number, length: number) => ({
          getChannelData: () => new Float32Array(length),
        })),
        createBufferSource: vi.fn(() => ({
          buffer: null,
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        })),
      };
      vi.stubGlobal(
        "AudioContext",
        vi.fn(() => fakeCtx),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("unlocks audio on header button gesture, scales BPM display, and persists mute toggle", async () => {
      const user = userEvent.setup();
      const now = 1_700_000_000_000;
      setPreferredName("Alice");
      setRoomToken("ABCD", "tok-alice");
      window.history.replaceState({}, "", "/room/ABCD");

      const { unmount } = render(<App createSocket={createSocket} />);
      const sock = sockets[0]!;

      act(() => {
        sock.emitOpen();
        sock.emitServerMessage({
          type: "room_snapshot",
          roomCode: "ABCD",
          phase: "IN_MATCH",
          matchPhase: "ROUND_ACTIVE",
          round: 1,
          totalRounds: 2,
          selfPlayerId: "p1",
          playerToken: "tok-alice",
          serverNow: now,
          phaseEndsAt: now + 60_000,
          players: [
            {
              id: "p1",
              name: "Alice",
              avatarId: "skull",
              isHost: true,
              connected: true,
              joinedAt: now,
              alive: true,
              doom: 50,
            },
            {
              id: "p2",
              name: "Bob",
              avatarId: "raven",
              isHost: false,
              connected: true,
              joinedAt: now + 100,
              alive: true,
              doom: 20,
            },
          ],
        });
      });

      const audioBtn = screen.getByTestId("audio-toggle-btn");
      expect(audioBtn).toHaveTextContent(/unlock/i);

      await user.click(audioBtn);
      expect(fakeCtx.resume).toHaveBeenCalledTimes(1);
      expect(fakeCtx.createBuffer).toHaveBeenCalledWith(1, 1, 22050);
      expect(audioBtn).toHaveTextContent("110");

      // Toggle mute on -> persists to localStorage
      await user.click(audioBtn);
      expect(audioBtn).toHaveTextContent(/muted/i);
      expect(getAudioMuted()).toBe(true);

      // Remounting preserves muted preference
      unmount();
      render(<App createSocket={createSocket} />);
      const sock2 = sockets[1]!;
      act(() => {
        sock2.emitOpen();
        sock2.emitServerMessage({
          type: "room_snapshot",
          roomCode: "ABCD",
          phase: "IN_MATCH",
          matchPhase: "ROUND_ACTIVE",
          round: 1,
          totalRounds: 2,
          selfPlayerId: "p1",
          playerToken: "tok-alice",
          serverNow: now,
          phaseEndsAt: now + 60_000,
          players: [
            {
              id: "p1",
              name: "Alice",
              avatarId: "skull",
              isHost: true,
              connected: true,
              joinedAt: now,
              alive: true,
              doom: 50,
            },
          ],
        });
      });

      await user.click(screen.getByTestId("audio-toggle-btn"));
      expect(screen.getByTestId("audio-toggle-btn")).toHaveTextContent(/muted/i);
    });

    it("triggers impact shake, static flash, and 1850Hz static burst on Whisper interception, Curse hit, and Doom spike", async () => {
      const user = userEvent.setup();
      const now = 1_700_000_000_000;
      setPreferredName("Alice");
      setRoomToken("ABCD", "tok-alice");
      window.history.replaceState({}, "", "/room/ABCD");

      render(<App createSocket={createSocket} />);
      const sock = sockets[0]!;

      act(() => {
        sock.emitOpen();
        sock.emitServerMessage({
          type: "room_snapshot",
          roomCode: "ABCD",
          phase: "IN_MATCH",
          matchPhase: "ROUND_ACTIVE",
          round: 1,
          totalRounds: 2,
          selfPlayerId: "p1",
          playerToken: "tok-alice",
          serverNow: now,
          phaseEndsAt: now + 60_000,
          players: [
            {
              id: "p1",
              name: "Alice",
              avatarId: "skull",
              isHost: true,
              connected: true,
              joinedAt: now,
              alive: true,
              doom: 30,
            },
          ],
        });
      });

      await user.click(screen.getByTestId("audio-toggle-btn"));
      const countBandpass = () =>
        fakeCtx.filters.filter(
          (f) => f.type === "bandpass" && f.frequency.value === 1850 && f.Q.value === 1.4,
        ).length;
      expect(countBandpass()).toBe(0);

      // 1. Whisper interception
      act(() => {
        sock.emitServerMessage({
          type: "entity_announcement",
          id: "e-whisper",
          beatType: "WHISPER_INTERCEPTED",
          text: "The Entity intercepted a Whisper!",
          timestamp: now + 1000,
        });
      });

      expect(screen.getByTestId("app-viewport")).toHaveClass("impact-now");
      expect(screen.getByTestId("static-flash")).toHaveClass("active");
      expect(countBandpass()).toBe(1);

      // 2. Curse hit
      act(() => {
        sock.emitServerMessage({
          type: "entity_announcement",
          id: "e-curse",
          beatType: "CURSE_TRIGGERED",
          text: "A Ghost Curse seared Alice!",
          timestamp: now + 2000,
        });
      });
      expect(countBandpass()).toBe(2);

      // 3. Doom spike (+25)
      act(() => {
        sock.emitServerMessage({
          type: "player_updated",
          players: [
            {
              id: "p1",
              name: "Alice",
              avatarId: "skull",
              isHost: true,
              connected: true,
              joinedAt: now,
              alive: true,
              doom: 55,
            },
          ],
        });
      });
      expect(countBandpass()).toBe(3);
    });
  });

  it("shows reconnect banner on IN_MATCH disconnect, triggers reconnect on visibilitychange/online, and restores via token", () => {
    const now = Date.now();
    setRoomToken("WXYZ", "tok-alice");
    window.history.replaceState({}, "", "/room/WXYZ");

    render(<App createSocket={createSocket} />);
    const sock = sockets[0]!;
    act(() => {
      sock.emitOpen();
      sock.emitServerMessage({
        type: "room_snapshot",
        roomCode: "WXYZ",
        phase: "IN_MATCH",
        matchPhase: "ROUND_ACTIVE",
        round: 1,
        totalRounds: 1,
        selfPlayerId: "p1",
        playerToken: "tok-alice",
        serverNow: now,
        phaseEndsAt: now + 50_000,
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: now,
            alive: true,
            doom: 50,
          },
          {
            id: "p2",
            name: "Bob",
            avatarId: "raven",
            isHost: false,
            connected: true,
            joinedAt: now + 100,
            alive: true,
            doom: 50,
          },
        ],
        feed: [],
      });
    });

    expect(screen.queryByTestId("reconnect-banner")).not.toBeInTheDocument();

    // Simulate mobile connection drop
    act(() => {
      sock.close();
    });
    expect(screen.getByTestId("reconnect-banner")).toHaveTextContent(
      /reconnecting/i,
    );

    // visibilitychange to visible triggers socket.reconnect()
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(sock.reconnectCount).toBe(1);

    // online event also triggers socket.reconnect() while still disconnected
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(sock.reconnectCount).toBe(2);

    // Socket reopens -> sends token join -> snapshot clears banner
    sock.sent = [];
    act(() => {
      sock.emitOpen();
    });
    expect(sock.sent).toContainEqual({
      type: "join",
      playerToken: "tok-alice",
    });

    act(() => {
      sock.emitServerMessage({
        type: "room_snapshot",
        roomCode: "WXYZ",
        phase: "IN_MATCH",
        matchPhase: "ROUND_ACTIVE",
        round: 1,
        totalRounds: 1,
        selfPlayerId: "p1",
        playerToken: "tok-alice",
        serverNow: now + 3000,
        phaseEndsAt: now + 50_000,
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: now,
            alive: true,
            doom: 50,
          },
          {
            id: "p2",
            name: "Bob",
            avatarId: "raven",
            isHost: false,
            connected: true,
            joinedAt: now + 100,
            alive: true,
            doom: 50,
          },
        ],
        feed: [],
      });
    });

    expect(screen.queryByTestId("reconnect-banner")).not.toBeInTheDocument();
  });

  it("supports Variant B left-rail Whisper targeting, violet composer, auto-reset to All, independent cooldown, and intercepted quote block", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/room/ABCD");
    render(<App createSocket={createSocket} />);

    const sock = sockets[0]!;
    const now = Date.now();
    act(() => {
      sock.emitOpen();
      sock.emitServerMessage({
        type: "room_snapshot",
        roomCode: "ABCD",
        phase: "IN_MATCH",
        matchPhase: "ROUND_ACTIVE",
        round: 1,
        totalRounds: 2,
        selfPlayerId: "p1",
        playerToken: "tok-1",
        serverNow: now,
        phaseEndsAt: now + 55_000,
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: now,
            alive: true,
            doom: 50,
          },
          {
            id: "p2",
            name: "Bob",
            avatarId: "raven",
            isHost: false,
            connected: true,
            joinedAt: now + 100,
            alive: true,
            doom: 50,
          },
          {
            id: "p3",
            name: "Cara",
            avatarId: "moth",
            isHost: false,
            connected: true,
            joinedAt: now + 200,
            alive: true,
            doom: 50,
          },
        ],
        feed: [],
      });
    });

    // Tap Bob on the left rail
    const bobNode = screen.getByTestId("rail-player-p2");
    await user.click(bobNode);

    expect(bobNode.className).toContain("selected");
    expect(screen.getByTestId("whisper-target-pill")).toHaveTextContent("Bob");
    const input = screen.getByPlaceholderText(/Whisper secretly to Bob/i);
    expect(input.className).toContain("whisper-mode");

    // Send a whisper -> emits send_whisper and auto-resets composer to All
    await user.type(input, "Vote Cara");
    await user.click(screen.getByRole("button", { name: /^Send$/i }));

    expect(sock.sent).toContainEqual({
      type: "send_whisper",
      targetPlayerId: "p2",
      text: "Vote Cara",
    });
    expect(screen.queryByTestId("whisper-target-pill")).not.toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Plead for your life/i),
    ).toBeInTheDocument();

    // Independent cooldown: public chat works immediately after whisper
    const publicInput = screen.getByPlaceholderText(/Plead for your life/i);
    await user.type(publicInput, "Spare me!");
    await user.click(screen.getByRole("button", { name: /^Send$/i }));
    expect(sock.sent).toContainEqual({
      type: "send_chat",
      text: "Spare me!",
    });

    // Receive whisper_message and whisper_intercepted
    act(() => {
      sock.emitServerMessage({
        type: "whisper_message",
        id: "w1",
        senderId: "p1",
        senderName: "Alice",
        senderAvatarId: "skull",
        targetId: "p2",
        targetName: "Bob",
        text: "Vote Cara",
        timestamp: now + 1000,
      });
      sock.emitServerMessage({
        type: "whisper_intercepted",
        id: "leak1",
        whisperId: "w1",
        senderId: "p1",
        senderName: "Alice",
        targetId: "p2",
        targetName: "Bob",
        headerText: "I overheard Alice whispering to Bob:",
        whisperText: "Vote Cara",
        timestamp: now + 2000,
      });
    });

    expect(screen.getByText(/Whisper to Bob/i)).toBeInTheDocument();
    expect(
      screen.getByText(/I overheard Alice whispering to Bob:/i),
    ).toBeInTheDocument();
    const quote = screen.getByTestId("intercepted-whisper-quote");
    expect(quote).toHaveTextContent("Vote Cara");
  });

  it("disables Whisper targeting when <= 2 living players remain", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/room/ABCD");
    render(<App createSocket={createSocket} />);

    const sock = sockets[0]!;
    const now = Date.now();
    act(() => {
      sock.emitOpen();
      sock.emitServerMessage({
        type: "room_snapshot",
        roomCode: "ABCD",
        phase: "IN_MATCH",
        matchPhase: "ROUND_ACTIVE",
        round: 1,
        totalRounds: 1,
        selfPlayerId: "p1",
        playerToken: "tok-1",
        serverNow: now,
        phaseEndsAt: now + 60_000,
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: now,
            alive: true,
            doom: 50,
          },
          {
            id: "p2",
            name: "Bob",
            avatarId: "raven",
            isHost: false,
            connected: true,
            joinedAt: now + 100,
            alive: true,
            doom: 50,
          },
        ],
        feed: [],
      });
    });

    const bobNode = screen.getByTestId("rail-player-p2");
    await user.click(bobNode);
    expect(screen.queryByTestId("whisper-target-pill")).not.toBeInTheDocument();
  });

  it("displays active Curse pills for a cursed living player and clears them on curse_resolved", () => {
    const now = 1_700_000_000_000;
    setPreferredName("Alice");
    setRoomToken("ABCD", "tok-alice");
    window.history.replaceState({}, "", "/room/ABCD");

    render(<App createSocket={createSocket} />);
    const sock = sockets[0]!;

    act(() => {
      sock.emitOpen();
      sock.emitServerMessage({
        type: "room_snapshot",
        roomCode: "ABCD",
        phase: "IN_MATCH",
        matchPhase: "ROUND_ACTIVE",
        round: 2,
        totalRounds: 2,
        selfPlayerId: "p1",
        playerToken: "tok-alice",
        serverNow: now,
        phaseEndsAt: now + 50_000,
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: now,
            alive: true,
            doom: 50,
          },
          {
            id: "p2",
            name: "Bob",
            avatarId: "raven",
            isHost: false,
            connected: true,
            joinedAt: now + 100,
            alive: false,
            doom: 100,
          },
        ],
        activeCurses: [],
      });
    });

    expect(screen.queryByTestId("active-curses-bar")).not.toBeInTheDocument();

    act(() => {
      sock.emitServerMessage({
        type: "curse_applied",
        curse: {
          id: "c1",
          ghostPlayerId: "p2",
          targetPlayerId: "p1",
          word: "blood",
          appliedAt: now + 1000,
        },
      });
    });

    const bar = screen.getByTestId("active-curses-bar");
    expect(bar).toHaveTextContent("blood");

    act(() => {
      sock.emitServerMessage({
        type: "curse_resolved",
        targetPlayerId: "p1",
        sourceMessageId: "m1",
        results: [
          { curseId: "c1", word: "blood", passed: true, reason: "NATURAL" },
        ],
      });
    });

    expect(screen.queryByTestId("active-curses-bar")).not.toBeInTheDocument();
  });

  it("switches Ghost composer to Curse mode with left-rail target selection and quick-pick chips", () => {
    const now = 1_700_000_000_000;
    setPreferredName("Alice");
    setRoomToken("ABCD", "tok-alice");
    window.history.replaceState({}, "", "/room/ABCD");

    render(<App createSocket={createSocket} />);
    const sock = sockets[0]!;

    act(() => {
      sock.emitOpen();
      sock.emitServerMessage({
        type: "room_snapshot",
        roomCode: "ABCD",
        phase: "IN_MATCH",
        matchPhase: "ROUND_ACTIVE",
        round: 2,
        totalRounds: 2,
        selfPlayerId: "p1",
        playerToken: "tok-alice",
        serverNow: now,
        phaseEndsAt: now + 50_000,
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: now,
            alive: false,
            doom: 100,
          },
          {
            id: "p2",
            name: "Bob",
            avatarId: "raven",
            isHost: false,
            connected: true,
            joinedAt: now + 100,
            alive: true,
            doom: 50,
          },
          {
            id: "p3",
            name: "Cara",
            avatarId: "moth",
            isHost: false,
            connected: true,
            joinedAt: now + 200,
            alive: true,
            doom: 40,
          },
        ],
        activeCurses: [],
      });
    });

    const composer = screen.getByTestId("curse-composer");
    expect(composer).toBeInTheDocument();

    // Select Bob on the left rail
    fireEvent.click(screen.getByTestId("rail-player-p2"));
    expect(screen.getByTestId("rail-player-p2")).toHaveClass("curse-selected");

    // Tap quick-pick chip "mercy" and submit
    fireEvent.click(screen.getByRole("button", { name: "mercy" }));
    fireEvent.click(screen.getByRole("button", { name: /cast curse/i }));

    expect(sock.sent).toContainEqual({
      type: "cast_curse",
      targetPlayerId: "p2",
      word: "mercy",
    });
  });
});

describe("SPA Socket Seam — POST_MATCH summary, conditional awards, Match log drawer & Host rematch", () => {
  let sockets: FakeRoomSocket[];
  let createSocket: CreateRoomSocket;

  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    setRoomToken("PQRS", "tok-1");
    window.history.replaceState({}, "", "/room/PQRS");
    sockets = [];
    createSocket = (roomCode) => {
      const sock = new FakeRoomSocket(roomCode);
      sockets.push(sock);
      return sock;
    };
  });

  it("renders SURVIVOR summary, elimination timeline, conditional awards, locked chat, and read-only Match log drawer excluding un-leaked whispers", async () => {
    const user = userEvent.setup();
    render(<App createSocket={createSocket} />);
    const sock = sockets[0]!;
    act(() => {
      sock.emitOpen();
    });

    const now = Date.now();
    const players = [
      {
        id: "p1",
        name: "Alice",
        avatarId: "skull" as const,
        isHost: true,
        connected: true,
        joinedAt: now,
        alive: true,
        doom: 42,
      },
      {
        id: "p2",
        name: "Bob",
        avatarId: "raven" as const,
        isHost: false,
        connected: true,
        joinedAt: now + 100,
        alive: false,
        doom: 100,
      },
      {
        id: "p3",
        name: "Carol",
        avatarId: "moth" as const,
        isHost: false,
        connected: true,
        joinedAt: now + 200,
        alive: false,
        doom: 100,
      },
    ];

    act(() => {
      sock.emitServerMessage({
        type: "room_snapshot",
        roomCode: "PQRS",
        phase: "IN_MATCH",
        matchPhase: "ROUND_ACTIVE",
        round: 2,
        totalRounds: 2,
        selfPlayerId: "p1",
        playerToken: "tok-1",
        serverNow: now,
        phaseEndsAt: now + 30_000,
        players,
        feed: [
          {
            kind: "chat",
            id: "f1",
            playerId: "p1",
            playerName: "Alice",
            avatarId: "skull",
            text: "Spare me, O Entity!",
            timestamp: now - 5000,
          },
          {
            kind: "whisper",
            id: "f2",
            senderId: "p1",
            senderName: "Alice",
            senderAvatarId: "skull",
            targetId: "p2",
            targetName: "Bob",
            text: "This secret whisper must never appear in POST_MATCH log",
            timestamp: now - 4000,
          },
          {
            kind: "whisper_intercepted",
            id: "f3",
            whisperId: "w9",
            senderId: "p2",
            senderName: "Bob",
            targetId: "p3",
            targetName: "Carol",
            headerText: "Bob's betrayal echoes in the dark.",
            whisperText: "Vote Alice out next!",
            timestamp: now - 3000,
          },
        ],
      });
    });

    act(() => {
      sock.emitServerMessage({
        type: "phase_changed",
        phase: "POST_MATCH",
        matchPhase: null,
        round: 2,
        totalRounds: 2,
        serverNow: now,
        phaseEndsAt: null,
        players,
        winnerId: "p1",
        endReason: "SURVIVOR",
        postMatchSummary: {
          endReason: "SURVIVOR",
          winnerId: "p1",
          closingBeat: "Alice walks out through the ash.",
          eliminations: [
            {
              round: 1,
              playerId: "p3",
              playerName: "Carol",
              avatarId: "moth",
              cause: "TIMER",
            },
            {
              round: 2,
              playerId: "p2",
              playerName: "Bob",
              avatarId: "raven",
              cause: "SPIKE",
            },
          ],
          awards: [
            {
              id: "closest_call",
              title: "Closest Call",
              playerId: "p1",
              playerName: "Alice",
              detail: "88% peak Doom",
            },
            {
              id: "curse_magnet",
              title: "Curse Magnet",
              playerId: "p1",
              playerName: "Alice",
              detail: "2 Curses endured",
            },
            {
              id: "exposed",
              title: "Exposed",
              playerId: "p2",
              playerName: "Bob",
              detail: 'To Carol: "Vote Alice out next!"',
            },
          ],
        },
      });
    });

    expect(screen.getByTestId("post-match-screen")).toBeInTheDocument();
    expect(screen.getByTestId("survivor-spotlight")).toHaveTextContent("Alice");
    expect(
      screen.getByText("Alice walks out through the ash."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("elimination-timeline")).toHaveTextContent("Carol");
    expect(screen.getByTestId("elimination-timeline")).toHaveTextContent("Bob");
    expect(screen.getByText("Closest Call")).toBeInTheDocument();
    expect(screen.getByText("88% peak Doom")).toBeInTheDocument();
    expect(screen.getByText("Curse Magnet")).toBeInTheDocument();
    expect(screen.getByText("Exposed")).toBeInTheDocument();

    // Live chat composer is locked / disabled
    expect(
      screen.queryByPlaceholderText(/plead for your life/i),
    ).not.toBeInTheDocument();

    // Open read-only Match Log drawer
    await user.click(screen.getByRole("button", { name: /view match log/i }));
    const drawer = screen.getByTestId("match-log-drawer");
    expect(drawer).toBeInTheDocument();
    expect(drawer).toHaveTextContent("Spare me, O Entity!");
    expect(drawer).toHaveTextContent("Vote Alice out next!");
    expect(drawer).not.toHaveTextContent(
      "This secret whisper must never appear in POST_MATCH log",
    );

    // Close drawer
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByTestId("match-log-drawer")).not.toBeInTheDocument();
  });

  it("renders ALL_CLAIMED and JUDGE_ERROR views and omits untriggered awards", () => {
    render(<App createSocket={createSocket} />);
    const sock = sockets[0]!;
    act(() => {
      sock.emitOpen();
    });

    const now = Date.now();
    const deadPlayers = [
      {
        id: "p1",
        name: "Alice",
        avatarId: "skull" as const,
        isHost: false,
        connected: true,
        joinedAt: now,
        alive: false,
        doom: 100,
      },
      {
        id: "p2",
        name: "Bob",
        avatarId: "raven" as const,
        isHost: true,
        connected: true,
        joinedAt: now + 100,
        alive: false,
        doom: 100,
      },
    ];

    act(() => {
      sock.emitServerMessage({
        type: "room_snapshot",
        roomCode: "PQRS",
        phase: "POST_MATCH",
        matchPhase: null,
        round: 1,
        totalRounds: 1,
        selfPlayerId: "p1",
        playerToken: "tok-1",
        serverNow: now,
        phaseEndsAt: null,
        players: deadPlayers,
        winnerId: null,
        endReason: "ALL_CLAIMED",
        postMatchSummary: {
          endReason: "ALL_CLAIMED",
          winnerId: null,
          closingBeat: "No soul escaped the chamber.",
          eliminations: [],
          awards: [],
        },
        feed: [],
      });
    });

    expect(screen.getByText(/all souls claimed/i)).toBeInTheDocument();
    expect(screen.getByText("No soul escaped the chamber.")).toBeInTheDocument();
    expect(screen.queryByTestId("survivor-spotlight")).not.toBeInTheDocument();
    expect(screen.queryByTestId("post-match-awards")).not.toBeInTheDocument();

    // JUDGE_ERROR banner
    act(() => {
      sock.emitServerMessage({
        type: "phase_changed",
        phase: "POST_MATCH",
        matchPhase: null,
        round: 1,
        totalRounds: 1,
        serverNow: now,
        phaseEndsAt: null,
        players: deadPlayers,
        winnerId: null,
        endReason: "JUDGE_ERROR",
        postMatchSummary: {
          endReason: "JUDGE_ERROR",
          winnerId: null,
          closingBeat: "The Entity fell silent — Match aborted",
          eliminations: [],
          awards: [],
        },
      });
    });

    expect(
      screen.getByText("The Entity fell silent — Match aborted"),
    ).toBeInTheDocument();
  });

  it("supports Host Play Again returning to WAITING, non-Host waiting state, and Leave Room returning to landing", async () => {
    const user = userEvent.setup();
    render(<App createSocket={createSocket} />);
    const sock = sockets[0]!;
    act(() => {
      sock.emitOpen();
    });

    const now = Date.now();
    const players = [
      {
        id: "p1",
        name: "Alice",
        avatarId: "skull" as const,
        isHost: false,
        connected: true,
        joinedAt: now,
        alive: true,
        doom: 40,
      },
      {
        id: "p2",
        name: "Bob",
        avatarId: "raven" as const,
        isHost: true,
        connected: true,
        joinedAt: now + 100,
        alive: false,
        doom: 100,
      },
    ];

    act(() => {
      sock.emitServerMessage({
        type: "room_snapshot",
        roomCode: "PQRS",
        phase: "POST_MATCH",
        matchPhase: null,
        round: 1,
        totalRounds: 1,
        selfPlayerId: "p1",
        playerToken: "tok-1",
        serverNow: now,
        phaseEndsAt: null,
        players,
        winnerId: "p1",
        endReason: "SURVIVOR",
        postMatchSummary: {
          endReason: "SURVIVOR",
          winnerId: "p1",
          closingBeat: "Alice survived.",
          eliminations: [],
          awards: [],
        },
        feed: [],
      });
    });

    // Non-Host Alice does not see Play Again
    expect(
      screen.queryByRole("button", { name: /play again/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/waiting for host to start rematch/i),
    ).toBeInTheDocument();

    // Host Bob leaves -> Alice becomes Host and sees Play Again
    act(() => {
      sock.emitServerMessage({
        type: "player_updated",
        players: [{ ...players[0]!, isHost: true }],
      });
    });

    const playAgainBtn = screen.getByRole("button", { name: /play again/i });
    await user.click(playAgainBtn);
    expect(sock.sent).toContainEqual({ type: "play_again" });

    // Server transitions back to WAITING
    act(() => {
      sock.emitServerMessage({
        type: "phase_changed",
        phase: "WAITING",
        matchPhase: null,
        round: 0,
        totalRounds: 0,
        serverNow: now,
        phaseEndsAt: null,
        players: [{ ...players[0]!, isHost: true, alive: true, doom: 50 }],
        postMatchSummary: null,
      });
    });

    expect(screen.queryByTestId("post-match-screen")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start match/i })).toBeInTheDocument();

    // Leave Room from landing/waiting works; also test Leave Room directly from POST_MATCH
    act(() => {
      sock.emitServerMessage({
        type: "phase_changed",
        phase: "POST_MATCH",
        matchPhase: null,
        round: 1,
        totalRounds: 1,
        serverNow: now,
        phaseEndsAt: null,
        players: [{ ...players[0]!, isHost: true }],
        winnerId: "p1",
        endReason: "SURVIVOR",
        postMatchSummary: {
          endReason: "SURVIVOR",
          winnerId: "p1",
          closingBeat: "Alice survived.",
          eliminations: [],
          awards: [],
        },
      });
    });

    await user.click(screen.getByRole("button", { name: /leave room/i }));
    expect(sock.sent).toContainEqual({ type: "leave_room" });
    expect(screen.getByRole("button", { name: /create room/i })).toBeInTheDocument();
  });

  it("transitions to POST_MATCH and strips un-leaked whispers when receiving match_ended directly", async () => {
    const user = userEvent.setup();
    render(<App createSocket={createSocket} />);
    const sock = sockets[0]!;
    act(() => {
      sock.emitOpen();
    });
    const now = Date.now();
    const players = [
      {
        id: "p1",
        name: "Alice",
        avatarId: "skull" as const,
        isHost: true,
        connected: true,
        joinedAt: now,
        alive: true,
        doom: 42,
      },
      {
        id: "p2",
        name: "Bob",
        avatarId: "raven" as const,
        isHost: false,
        connected: true,
        joinedAt: now + 100,
        alive: false,
        doom: 100,
      },
    ];

    act(() => {
      sock.emitServerMessage({
        type: "room_snapshot",
        roomCode: "END1",
        phase: "IN_MATCH",
        matchPhase: "ROUND_ACTIVE",
        round: 1,
        totalRounds: 1,
        selfPlayerId: "p1",
        playerToken: "tok-1",
        serverNow: now,
        phaseEndsAt: now + 30_000,
        players,
        feed: [
          {
            kind: "chat",
            id: "f1",
            playerId: "p1",
            playerName: "Alice",
            avatarId: "skull",
            text: "Public plea",
            timestamp: now - 5000,
          },
          {
            kind: "whisper",
            id: "f2",
            senderId: "p1",
            senderName: "Alice",
            senderAvatarId: "skull",
            targetId: "p2",
            targetName: "Bob",
            text: "Secret whisper",
            timestamp: now - 4000,
          },
        ],
      });
    });

    act(() => {
      sock.emitServerMessage({
        type: "match_ended",
        roomStatus: "POST_MATCH",
        round: 1,
        totalRounds: 1,
        serverNow: now,
        players,
        winnerId: "p1",
        endReason: "SURVIVOR",
        postMatchSummary: {
          endReason: "SURVIVOR",
          winnerId: "p1",
          closingBeat: "Alice walks out alone.",
          eliminations: [
            {
              round: 1,
              playerId: "p2",
              playerName: "Bob",
              avatarId: "raven",
              cause: "SPIKE",
            },
          ],
          awards: [],
        },
      });
    });

    expect(screen.getByTestId("post-match-screen")).toBeInTheDocument();
    expect(screen.getByText(/Alice walks out alone\./i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /view match log/i }));
    expect(screen.getByText(/Public plea/i)).toBeInTheDocument();
    expect(screen.queryByText(/Secret whisper/i)).not.toBeInTheDocument();
  });
});

describe("SPA Socket Seam — Input processing & Doom-update feedback (#27)", () => {
  let sockets: FakeRoomSocket[];
  let createSocket: CreateRoomSocket;

  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    setRoomToken("FEED", "tok-alice");
    window.history.replaceState({}, "", "/room/FEED");
    sockets = [];
    createSocket = (roomCode) => {
      const sock = new FakeRoomSocket(roomCode);
      sockets.push(sock);
      return sock;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderActiveRound(now = Date.now()) {
    render(<App createSocket={createSocket} />);
    const sock = sockets[0]!;
    act(() => {
      sock.emitOpen();
      sock.emitServerMessage({
        type: "room_snapshot",
        roomCode: "FEED",
        phase: "IN_MATCH",
        matchPhase: "ROUND_ACTIVE",
        round: 1,
        totalRounds: 2,
        selfPlayerId: "p1",
        playerToken: "tok-alice",
        serverNow: now,
        phaseEndsAt: now + 120_000,
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: now,
            alive: true,
            doom: 50,
          },
          {
            id: "p2",
            name: "Bob",
            avatarId: "raven",
            isHost: false,
            connected: true,
            joinedAt: now + 100,
            alive: true,
            doom: 50,
          },
          {
            id: "p3",
            name: "Cara",
            avatarId: "moth",
            isHost: false,
            connected: true,
            joinedAt: now + 200,
            alive: true,
            doom: 50,
          },
        ],
        feed: [],
      });
    });
    return { sock, now };
  }

  it("shows judging loader on submit & echoed plea, ignores rival Doom updates, and renders verdict + rail delta on matching doom_updated", async () => {
    const user = userEvent.setup();
    const { sock, now } = renderActiveRound();

    expect(screen.queryByTestId("judge-status-indicator")).not.toBeInTheDocument();

    const input = screen.getByPlaceholderText(/plead for your life/i);
    await user.type(input, "Bob is hiding everything!");
    await user.click(screen.getByRole("button", { name: /^Send$/i }));

    // Optimistic judging indicator appears immediately without locking the input
    const indicator = screen.getByTestId("judge-status-indicator");
    expect(indicator).toHaveAttribute("data-status", "judging");
    expect(indicator).toHaveTextContent("The Entity is judging your plea...");
    expect(screen.getByTestId("judge-spinner")).toBeInTheDocument();
    expect(screen.getByTestId("rail-player-p1")).toHaveAttribute(
      "data-judging",
      "true",
    );
    expect(input).not.toBeDisabled();

    // Server echoes Alice's chat message with pendingJudge: true
    act(() => {
      sock.emitServerMessage({
        type: "chat_message",
        id: "m1",
        playerId: "p1",
        playerName: "Alice",
        avatarId: "skull",
        text: "Bob is hiding everything!",
        timestamp: now + 200,
        pendingJudge: true,
      });
    });

    expect(screen.getByTestId("msg-judge-pending-m1")).toHaveTextContent(
      "Weighing plea...",
    );
    expect(screen.getByTestId("judge-status-indicator")).toHaveAttribute(
      "data-status",
      "judging",
    );

    // Another player's plea resolves first and also affects Alice's Doom -> flashes rail deltas but MUST NOT clear Alice's pending state
    act(() => {
      sock.emitServerMessage({
        type: "chat_message",
        id: "m2",
        playerId: "p2",
        playerName: "Bob",
        avatarId: "raven",
        text: "No, watch Alice!",
        timestamp: now + 300,
        pendingJudge: true,
      });
      sock.emitServerMessage({
        type: "doom_updated",
        sourceMessageId: "m2",
        updates: [
          { playerId: "p2", doom: 45, delta: -5 },
          { playerId: "p1", doom: 55, delta: 5 },
        ],
      });
    });

    expect(screen.getByTestId("rail-doom-delta-p2")).toHaveTextContent("-5%");
    expect(screen.getByTestId("rail-doom-delta-p1")).toHaveTextContent("+5%");
    expect(screen.getByTestId("judge-status-indicator")).toHaveAttribute(
      "data-status",
      "judging",
    );
    expect(screen.getByTestId("msg-judge-pending-m1")).toBeInTheDocument();

    // Now Alice's m1 verdict arrives
    act(() => {
      sock.emitServerMessage({
        type: "doom_updated",
        sourceMessageId: "m1",
        updates: [
          { playerId: "p1", doom: 43, delta: -12 },
          { playerId: "p2", doom: 55, delta: 10 },
        ],
      });
    });

    expect(screen.queryByTestId("judge-spinner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("msg-judge-pending-m1")).not.toBeInTheDocument();
    expect(screen.getByTestId("rail-player-p1")).not.toHaveAttribute(
      "data-judging",
      "true",
    );

    const completedIndicator = screen.getByTestId("judge-status-indicator");
    expect(completedIndicator).toHaveAttribute("data-status", "completed");
    expect(completedIndicator).toHaveTextContent(
      "▼ Verdict in — Doom -12% (now 43%)",
    );

    const msgVerdict = screen.getByTestId("msg-judge-verdict-m1");
    expect(msgVerdict).toHaveTextContent("▼ -12% Doom");
    expect(msgVerdict).toHaveTextContent("Bob +10%");

    expect(screen.getByTestId("rail-doom-delta-p1")).toHaveTextContent("-12%");
    expect(screen.getByTestId("rail-doom-delta-p2")).toHaveTextContent("+10%");
    expect(screen.getByTestId("rail-player-p1")).toHaveTextContent("43%");
    expect(screen.getByTestId("rail-player-p2")).toHaveTextContent("55%");
  });

  it("displays positive and zero-delta completion feedback clearly", () => {
    vi.useFakeTimers();
    const { sock, now } = renderActiveRound(Date.now());
    const input = screen.getByPlaceholderText(/plead for your life/i);

    // 1. Positive delta (+8%)
    fireEvent.change(input, { target: { value: "aaaa" } });
    fireEvent.submit(input.closest("form")!);
    act(() => {
      sock.emitServerMessage({
        type: "chat_message",
        id: "m-pos",
        playerId: "p1",
        playerName: "Alice",
        avatarId: "skull",
        text: "aaaa",
        timestamp: now + 100,
        pendingJudge: true,
      });
      sock.emitServerMessage({
        type: "doom_updated",
        sourceMessageId: "m-pos",
        updates: [{ playerId: "p1", doom: 58, delta: 8 }],
      });
    });

    expect(screen.getByTestId("judge-status-indicator")).toHaveTextContent(
      "▲ Verdict in — Doom +8% (now 58%)",
    );
    expect(screen.getByTestId("msg-judge-verdict-m-pos")).toHaveTextContent(
      "▲ +8% Doom",
    );
    expect(screen.getByTestId("rail-doom-delta-p1")).toHaveTextContent("+8%");

    // Advance past 2.5s cooldown (within 12s timeout) and submit neutral plea (0% delta)
    act(() => {
      vi.advanceTimersByTime(2_600);
    });
    fireEvent.change(input, { target: { value: "Spare my soul tonight." } });
    fireEvent.submit(input.closest("form")!);
    act(() => {
      sock.emitServerMessage({
        type: "chat_message",
        id: "m-zero",
        playerId: "p1",
        playerName: "Alice",
        avatarId: "skull",
        text: "Spare my soul tonight.",
        timestamp: now + 2_800,
        pendingJudge: true,
      });
      sock.emitServerMessage({
        type: "doom_updated",
        sourceMessageId: "m-zero",
        updates: [{ playerId: "p1", doom: 58, delta: 0 }],
      });
    });

    expect(screen.getByTestId("judge-status-indicator")).toHaveTextContent(
      "✓ Verdict in — Doom unchanged (58%)",
    );
    expect(screen.getByTestId("msg-judge-verdict-m-zero")).toHaveTextContent(
      "✓ 0% Doom",
    );
    expect(screen.getByTestId("rail-doom-delta-p1")).toHaveTextContent("0%");
  });

  it("handles whispers, server errors, pendingJudge: false, overlapping pleas, and phase transitions cleanly", async () => {
    vi.useFakeTimers();
    const { sock, now } = renderActiveRound(Date.now());
    const input = screen.getByPlaceholderText(/plead for your life/i);

    // 1. Whispers must NOT trigger judge-status-indicator
    fireEvent.click(screen.getByTestId("rail-player-p2"));
    fireEvent.change(
      screen.getByPlaceholderText(/Whisper secretly to Bob/i),
      { target: { value: "Stay quiet" } },
    );
    fireEvent.submit(
      screen.getByPlaceholderText(/Whisper secretly to Bob/i).closest("form")!,
    );
    expect(sock.sent).toContainEqual({
      type: "send_whisper",
      targetPlayerId: "p2",
      text: "Stay quiet",
    });
    expect(screen.queryByTestId("judge-status-indicator")).not.toBeInTheDocument();

    // 2. Server error clears optimistic judging state
    fireEvent.change(input, { target: { value: "Hear my plea" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByTestId("judge-status-indicator")).toHaveAttribute(
      "data-status",
      "judging",
    );
    act(() => {
      sock.emitServerMessage({
        type: "error",
        code: "COOLDOWN_ACTIVE",
        message: "Wait before pleading again.",
      });
    });
    expect(screen.queryByTestId("judge-status-indicator")).not.toBeInTheDocument();

    // 3. pendingJudge: false clears optimistic judging state on echo without pending badge
    act(() => {
      vi.advanceTimersByTime(2_600);
    });
    fireEvent.change(input, { target: { value: "Local echo only" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByTestId("judge-status-indicator")).toHaveAttribute(
      "data-status",
      "judging",
    );
    act(() => {
      sock.emitServerMessage({
        type: "chat_message",
        id: "m-nojev",
        playerId: "p1",
        playerName: "Alice",
        avatarId: "skull",
        text: "Local echo only",
        timestamp: now + 2_700,
        pendingJudge: false,
      });
    });
    expect(screen.queryByTestId("judge-status-indicator")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("msg-judge-pending-m-nojev"),
    ).not.toBeInTheDocument();

    // 4. Overlapping pleas stay in judging until all resolve, and survive ROUND_RESOLVING until SACRIFICE_REVEAL
    act(() => {
      vi.advanceTimersByTime(2_600);
    });
    fireEvent.change(input, { target: { value: "First overlapping plea" } });
    fireEvent.submit(input.closest("form")!);
    act(() => {
      sock.emitServerMessage({
        type: "chat_message",
        id: "m-ov1",
        playerId: "p1",
        playerName: "Alice",
        avatarId: "skull",
        text: "First overlapping plea",
        timestamp: now + 5_400,
        pendingJudge: true,
      });
    });

    act(() => {
      vi.advanceTimersByTime(2_600);
    });
    fireEvent.change(input, { target: { value: "Second overlapping plea" } });
    fireEvent.submit(input.closest("form")!);
    act(() => {
      sock.emitServerMessage({
        type: "chat_message",
        id: "m-ov2",
        playerId: "p1",
        playerName: "Alice",
        avatarId: "skull",
        text: "Second overlapping plea",
        timestamp: now + 8_100,
        pendingJudge: true,
      });
    });

    expect(screen.getByTestId("judge-status-indicator")).toHaveTextContent(
      "The Entity is judging 2 pleas...",
    );

    // Resolve first plea only -> second plea keeps indicator in judging
    act(() => {
      sock.emitServerMessage({
        type: "doom_updated",
        sourceMessageId: "m-ov1",
        updates: [{ playerId: "p1", doom: 46, delta: -4 }],
      });
    });
    expect(screen.getByTestId("msg-judge-verdict-m-ov1")).toHaveTextContent(
      "▼ -4% Doom",
    );
    expect(screen.getByTestId("judge-status-indicator")).toHaveAttribute(
      "data-status",
      "judging",
    );
    expect(screen.getByTestId("judge-status-indicator")).toHaveTextContent(
      "The Entity is judging your plea...",
    );

    // Transition to ROUND_RESOLVING keeps in-flight m-ov2 pending
    act(() => {
      sock.emitServerMessage({
        type: "phase_changed",
        phase: "IN_MATCH",
        matchPhase: "ROUND_RESOLVING",
        round: 1,
        totalRounds: 2,
        serverNow: now + 120_000,
        phaseEndsAt: now + 123_000,
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: now,
            alive: true,
            doom: 46,
          },
          {
            id: "p2",
            name: "Bob",
            avatarId: "raven",
            isHost: false,
            connected: true,
            joinedAt: now + 100,
            alive: true,
            doom: 50,
          },
          {
            id: "p3",
            name: "Cara",
            avatarId: "moth",
            isHost: false,
            connected: true,
            joinedAt: now + 200,
            alive: true,
            doom: 50,
          },
        ],
      });
    });

    expect(screen.getByTestId("msg-judge-pending-m-ov2")).toBeInTheDocument();
    expect(screen.getByTestId("judge-status-indicator")).toHaveAttribute(
      "data-status",
      "judging",
    );

    // Transition to SACRIFICE_REVEAL clears stale pending loaders
    act(() => {
      sock.emitServerMessage({
        type: "phase_changed",
        phase: "IN_MATCH",
        matchPhase: "SACRIFICE_REVEAL",
        round: 1,
        totalRounds: 2,
        serverNow: now + 123_000,
        phaseEndsAt: now + 127_500,
        sacrificedPlayerId: "p2",
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: now,
            alive: true,
            doom: 46,
          },
          {
            id: "p2",
            name: "Bob",
            avatarId: "raven",
            isHost: false,
            connected: true,
            joinedAt: now + 100,
            alive: false,
            doom: 100,
          },
          {
            id: "p3",
            name: "Cara",
            avatarId: "moth",
            isHost: false,
            connected: true,
            joinedAt: now + 200,
            alive: true,
            doom: 50,
          },
        ],
      });
    });

    expect(
      screen.queryByTestId("msg-judge-pending-m-ov2"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("judge-spinner")).not.toBeInTheDocument();
    expect(screen.getByTestId("judge-status-indicator")).toHaveAttribute(
      "data-status",
      "completed",
    );

    // Transition to Round 2 ROUND_INTRO clears lastSelfVerdict banner too
    act(() => {
      sock.emitServerMessage({
        type: "phase_changed",
        phase: "IN_MATCH",
        matchPhase: "ROUND_INTRO",
        round: 2,
        totalRounds: 2,
        serverNow: now + 127_500,
        phaseEndsAt: now + 131_000,
        players: [
          {
            id: "p1",
            name: "Alice",
            avatarId: "skull",
            isHost: true,
            connected: true,
            joinedAt: now,
            alive: true,
            doom: 48,
          },
          {
            id: "p2",
            name: "Bob",
            avatarId: "raven",
            isHost: false,
            connected: true,
            joinedAt: now + 100,
            alive: false,
            doom: 100,
          },
          {
            id: "p3",
            name: "Cara",
            avatarId: "moth",
            isHost: false,
            connected: true,
            joinedAt: now + 200,
            alive: true,
            doom: 50,
          },
        ],
      });
    });

    expect(
      screen.queryByTestId("judge-status-indicator"),
    ).not.toBeInTheDocument();
  });
});
