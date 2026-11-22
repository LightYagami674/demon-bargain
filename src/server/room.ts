import { Server, type Connection, type WSMessage } from "partyserver";
import { TypeSafeJevEvaluator } from "./jev.js";
import { RoomCore, type RoomStorage, type RoomTransport } from "./room-core.js";

export interface Env {
  Room: DurableObjectNamespace<Room>;
  TYPESAFE_API_KEY?: string;
}

interface ConnectionAttachment {
  playerId?: string;
}

export class Room extends Server<Env> {
  static options = {
    hibernate: true,
  };

  private core: RoomCore | null = null;

  private ensureCore(): RoomCore {
    if (this.core) return this.core;

    const sql = this.ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS room_state (id INTEGER PRIMARY KEY CHECK (id = 1), state_json TEXT NOT NULL)",
    );

    const transport: RoomTransport = {
      send: (connectionId, payload) => {
        const conn = this.getConnection<ConnectionAttachment>(connectionId);
        conn?.send(payload);
      },
      broadcast: (payload, excludeConnectionIds) => {
        this.broadcast(payload, excludeConnectionIds);
      },
      close: (connectionId, code, reason) => {
        const conn = this.getConnection<ConnectionAttachment>(connectionId);
        conn?.close(code, reason);
      },
      onAttachPlayer: (connectionId, playerId) => {
        const conn = this.getConnection<ConnectionAttachment>(connectionId);
        conn?.setState({ playerId });
      },
    };

    const storage: RoomStorage = {
      load: () => {
        const cursor = sql.exec<{ state_json: string }>(
          "SELECT state_json FROM room_state WHERE id = 1",
        );
        const rows = cursor.toArray();
        return rows[0]?.state_json ?? null;
      },
      save: (stateJson) => {
        sql.exec(
          "INSERT INTO room_state (id, state_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json",
          stateJson,
        );
      },
      scheduleAlarm: (atEpochMs) => {
        if (atEpochMs === null) {
          void this.ctx.storage.deleteAlarm();
        } else {
          void this.ctx.storage.setAlarm(atEpochMs);
        }
      },
      deleteAll: () => {
        for (const conn of this.getConnections()) {
          conn.close(1000, "Room expired");
        }
        void this.ctx.storage.deleteAlarm();
        void this.ctx.storage.deleteAll();
        this.core = null;
      },
    };

    const core = new RoomCore({
      roomCode: this.name.toUpperCase(),
      transport,
      storage,
      ...(this.env.TYPESAFE_API_KEY
        ? { jevEvaluator: new TypeSafeJevEvaluator(this.env.TYPESAFE_API_KEY) }
        : {}),
    });

    for (const conn of this.getConnections<ConnectionAttachment>()) {
      const playerId = conn.state?.playerId;
      if (playerId) {
        core.rehydrateConnection(conn.id, playerId);
      }
    }

    this.core = core;
    return core;
  }

  onStart(): void {
    this.ensureCore();
  }

  onMessage(connection: Connection, message: WSMessage): void {
    const raw =
      typeof message === "string"
        ? message
        : new TextDecoder().decode(message);
    this.ensureCore().onMessage(connection.id, raw);
  }

  onClose(connection: Connection<ConnectionAttachment>): void {
    this.ensureCore().onClose(connection.id, connection.state?.playerId);
  }

  onAlarm(): void {
    this.ensureCore().onAlarm();
  }
}
