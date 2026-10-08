import type { ServerMessage } from '@remote-desktop/webrtc';
import type { WebSocket } from 'ws';

/** One WebSocket. Identity fields are set only after a successful `auth` handshake. */
export interface Connection {
  id: string;
  socket: WebSocket;
  ip: string;
  /** Single-use challenge for the device-key proof; cleared after `auth`. */
  nonce: string | null;
  userId: string | null;
  deviceId: string | null;
  deviceCode: string | null;
  /** Unix seconds; the socket is closed when the access token expires. */
  tokenExpiresAt: number;
  /** Supabase Auth session of the access token; re-checked so logout closes the socket. */
  authSessionId?: string | null;
  alive: boolean;
  protocolErrors: number;
  timers: NodeJS.Timeout[];
}

/**
 * In-memory index of authenticated sockets for this instance. Running several
 * signaling instances needs a shared bus (e.g. Redis pub/sub) behind the same
 * `sendTo*` functions; Phase 2 runs one instance.
 */
export class ConnectionRegistry {
  private readonly byUser = new Map<string, Set<Connection>>();
  private readonly byDevice = new Map<string, Connection>();
  readonly all = new Set<Connection>();

  /** Registers an authenticated connection. Returns a previous socket for the same device, if any. */
  add(connection: Connection): Connection | undefined {
    this.all.add(connection);
    if (connection.userId) {
      let set = this.byUser.get(connection.userId);
      if (!set) this.byUser.set(connection.userId, (set = new Set()));
      set.add(connection);
    }
    if (connection.deviceId) {
      const previous = this.byDevice.get(connection.deviceId);
      this.byDevice.set(connection.deviceId, connection);
      return previous;
    }
    return undefined;
  }

  /** Removes a connection. Returns true when it was the device's current socket. */
  remove(connection: Connection): boolean {
    this.all.delete(connection);
    if (connection.userId) {
      const set = this.byUser.get(connection.userId);
      set?.delete(connection);
      if (set?.size === 0) this.byUser.delete(connection.userId);
    }
    if (connection.deviceId && this.byDevice.get(connection.deviceId) === connection) {
      this.byDevice.delete(connection.deviceId);
      return true;
    }
    return false;
  }

  device(deviceId: string): Connection | undefined {
    return this.byDevice.get(deviceId);
  }

  /** Whether the user has an authenticated socket without device identity. */
  hasDevicelessSocket(userId: string): boolean {
    for (const connection of this.byUser.get(userId) ?? []) {
      if (!connection.deviceId) return true;
    }
    return false;
  }

  connectedDeviceIds(): string[] {
    return [...this.byDevice.keys()];
  }

  sendToDevice(deviceId: string, message: ServerMessage): boolean {
    const connection = this.byDevice.get(deviceId);
    if (!connection) return false;
    send(connection, message);
    return true;
  }

  sendToUser(userId: string, message: ServerMessage): number {
    const set = this.byUser.get(userId);
    if (!set) return 0;
    for (const connection of set) send(connection, message);
    return set.size;
  }
}

export function send(connection: Connection, message: ServerMessage): void {
  if (connection.socket.readyState === connection.socket.OPEN) {
    connection.socket.send(JSON.stringify(message));
  }
}
