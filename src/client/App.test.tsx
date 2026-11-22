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
