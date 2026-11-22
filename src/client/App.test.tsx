import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App.js";
import type { CreateRoomSocket, RoomSocket } from "./socket.js";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";
import { isValidRoomCode } from "../shared/constants.js";
import {
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
});
