import PartySocket from "partysocket";

export interface RoomSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  reconnect?: (code?: number, reason?: string) => void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: string }) => void,
  ): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  removeEventListener(type: "open", listener: () => void): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: string }) => void,
  ): void;
  removeEventListener(type: "close", listener: () => void): void;
  removeEventListener(type: "error", listener: () => void): void;
}

export type CreateRoomSocket = (roomCode: string) => RoomSocket;

export const createPartyRoomSocket: CreateRoomSocket = (roomCode: string) => {
  const socket = new PartySocket({
    host: window.location.host,
    party: "room",
    room: roomCode.toUpperCase(),
  });
  return socket as unknown as RoomSocket;
};
