import { EventEmitter } from 'node:events';
import {
  deviceAuthMessage,
  serverMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from '@remote-desktop/webrtc';

export class SignalingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SignalingError';
  }
}

export interface SignalingIdentity {
  accessToken: string;
  /** Present when this computer is a registered device (needed to receive requests). */
  device: { deviceId: string; sign(message: string): Promise<string | null> } | null;
}

export type SignalingStatus = 'disconnected' | 'connecting' | 'connected';

interface Events {
  message: [message: ServerMessage];
  status: [status: SignalingStatus];
}

type Outgoing = Exclude<ClientMessage, { type: 'auth' }>;
type Payload<T extends Outgoing['type']> = Extract<Outgoing, { type: T }>['payload'];

/**
 * The desktop's connection to apps/signaling, held by the main process (it
 * needs the access token and the device private key, neither of which the
 * renderer may see). Reconnects with backoff; every reconnect re-authenticates
 * with a fresh token and a fresh nonce signature.
 */
export class SignalingClient extends EventEmitter<Events> {
  private socket: WebSocket | null = null;
  private status: SignalingStatus = 'disconnected';
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  private readonly pending = new Map<
    string,
    {
      resolve: (payload: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(
    private readonly url: string,
    private readonly identity: () => Promise<SignalingIdentity | null>,
  ) {
    super();
  }

  get connected(): boolean {
    return this.status === 'connected';
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  /** Closes and stays closed until `start` (sign-out, quit). */
  stop(reason = 'stopped'): void {
    if (!this.stopped) console.warn(`[signaling] stopping (${reason})`);
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(1000, 'Client stopping');
    this.socket = null;
    this.setStatus('disconnected');
    this.failPending(new SignalingError('disconnected', 'Signaling connection closed'));
  }

  /** Reconnect now (e.g. after this device was registered, to gain device identity). */
  restart(): void {
    this.stop('restart');
    this.start();
  }

  private setStatus(status: SignalingStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  private open(): void {
    if (this.stopped) return;
    this.setStatus('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    // Handles the end of this socket exactly once, whichever event reports it.
    // Electron's bundled Node (22.x) fires only 'error' — never 'close' — when
    // the connection is refused, leaving the socket stuck in CONNECTING.
    const ended = (detail: string) => {
      if (this.socket !== socket) return;
      clearTimeout(connectTimer);
      console.warn(`[signaling] connection closed (${detail})`);
      this.socket = null;
      this.setStatus('disconnected');
      this.failPending(new SignalingError('disconnected', 'Signaling connection lost'));
      try {
        socket.close();
      } catch {
        // already closed
      }
      this.scheduleReconnect();
    };
    const connectTimer = setTimeout(() => {
      if (socket.readyState === WebSocket.CONNECTING) ended('connect timeout');
    }, 10_000);
    socket.addEventListener('open', () => clearTimeout(connectTimer));
    socket.addEventListener('message', (event) => void this.onFrame(socket, event.data));
    socket.addEventListener('close', (event) =>
      ended(`${event.code}${event.reason ? ` ${event.reason}` : ''}`),
    );
    socket.addEventListener('error', () => ended('error'));
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay =
      Math.min(30_000, 1_000 * 2 ** Math.min(this.attempt, 5)) * (0.75 + Math.random() * 0.5);
    this.attempt += 1;
    console.warn(`[signaling] reconnecting in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private async onFrame(socket: WebSocket, data: unknown): Promise<void> {
    if (typeof data !== 'string') return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = serverMessageSchema.safeParse(json);
    if (!parsed.success) return;
    const message = parsed.data;

    if (message.type === 'auth.challenge') {
      await this.authenticate(socket, message.payload.nonce);
      return;
    }
    if (message.type === 'auth.ok') {
      if (this.attempt > 0) console.warn('[signaling] reconnected');
      this.attempt = 0;
      this.setStatus('connected');
      return;
    }
    if (message.type === 'ack' || message.type === 'error') {
      const pending = message.id === null ? undefined : this.pending.get(message.id);
      if (pending && message.id !== null) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.type === 'ack') pending.resolve(message.payload);
        else pending.reject(new SignalingError(message.payload.code, message.payload.message));
      }
      return;
    }
    this.emit('message', message);
  }

  private async authenticate(socket: WebSocket, nonce: string): Promise<void> {
    const identity = await this.identity().catch((error: unknown) => {
      console.warn('[signaling] could not load identity', (error as Error).message);
      return null;
    });
    if (!identity) {
      // Signed out meanwhile: stop rather than retry with nothing.
      this.stop('no identity');
      return;
    }
    const payload: Record<string, unknown> = { accessToken: identity.accessToken };
    if (identity.device) {
      const signature = await identity.device.sign(
        deviceAuthMessage(nonce, identity.device.deviceId),
      );
      if (signature) payload['device'] = { deviceId: identity.device.deviceId, signature };
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'auth', id: 'auth', payload }));
    }
  }

  /** Sends a request and resolves with the server's ack payload. */
  request<T extends Outgoing['type']>(
    type: T,
    payload: Payload<T>,
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket || this.status !== 'connected' || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new SignalingError('offline', 'Not connected to the signaling service'),
      );
    }
    const id = `m${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SignalingError('timeout', 'The signaling service did not answer'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type, id, payload }));
    });
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
