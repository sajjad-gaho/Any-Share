// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalingClient } from './signaling-client';

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

/**
 * Minimal WebSocket double. `behaviour` decides what a new socket does:
 * 'refuse-error-only' mimics Electron's Node 22 (only 'error', no 'close').
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static behaviour: 'refuse-error-only' | 'refuse-close' | 'accept' | 'hang' = 'accept';
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = FakeSocket.CONNECTING;
  readonly sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      if (FakeSocket.behaviour === 'hang') return; // never opens, never errors
      if (FakeSocket.behaviour === 'accept') {
        this.readyState = FakeSocket.OPEN;
        this.fire('open', {});
        this.fire('message', {
          data: JSON.stringify({
            type: 'auth.challenge',
            payload: { nonce: 'n1', protocolVersion: 1 },
          }),
        });
      } else {
        this.fire('error', {});
        if (FakeSocket.behaviour === 'refuse-close') {
          this.readyState = 3;
          this.fire('close', { code: 1006 });
        }
      }
    });
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string, event: Parameters<Listener>[0]) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(data: string) {
    this.sent.push(data);
    const message = JSON.parse(data) as { type: string };
    if (message.type === 'auth') {
      queueMicrotask(() =>
        this.fire('message', {
          data: JSON.stringify({
            type: 'auth.ok',
            payload: {
              userId: '6c1a7c1e-6e2f-4d6a-9a43-3c1d2f0b7a11',
              deviceId: null,
              deviceCode: null,
            },
          }),
        }),
      );
    }
  }
  close() {
    this.readyState = 3;
  }
}

describe('SignalingClient reconnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    FakeSocket.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const identity = async () => ({
    accessToken: 'token-that-is-long-enough',
    device: { deviceId: '41b4c51e-6104-443a-b05a-62640705759c', sign: async () => 'sig' },
  });

  it.each(['refuse-error-only', 'refuse-close'] as const)(
    'keeps retrying when connections are refused (%s) and recovers',
    async (behaviour) => {
      FakeSocket.behaviour = behaviour;
      const client = new SignalingClient('ws://127.0.0.1:1/ws', identity);
      const statuses: string[] = [];
      client.on('status', (s) => statuses.push(s));
      client.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(3);

      FakeSocket.behaviour = 'accept';
      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.connected).toBe(true);
      expect(statuses.at(-1)).toBe('connected');
      const auth = JSON.parse(FakeSocket.instances.at(-1)?.sent[0] ?? '{}') as {
        payload: { device: { signature: string } };
      };
      expect(auth.payload.device.signature).toBe('sig');
      client.stop();
    },
  );

  it('abandons a socket stuck in CONNECTING after the connect timeout', async () => {
    FakeSocket.behaviour = 'hang';
    const client = new SignalingClient('ws://127.0.0.1:1/ws', identity);
    client.start();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500 + 2_000);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
    client.stop();
  });

  it('stops for good when there is no identity (signed out)', async () => {
    FakeSocket.behaviour = 'accept';
    const client = new SignalingClient('ws://127.0.0.1:1/ws', async () => null);
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(client.connected).toBe(false);
  });
});
