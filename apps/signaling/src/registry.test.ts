import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { ConnectionRegistry, type Connection } from './registry';

function fakeConnection(
  id: string,
  userId: string | null,
  deviceId: string | null = null,
): Connection & { sent: string[] } {
  const sent: string[] = [];
  const socket = { OPEN: 1, readyState: 1, send: (data: string) => sent.push(data) };
  return {
    id,
    socket: socket as unknown as WebSocket,
    ip: '127.0.0.1',
    nonce: null,
    userId,
    deviceId,
    deviceCode: null,
    tokenExpiresAt: 0,
    alive: true,
    protocolErrors: 0,
    timers: [],
    sent,
  };
}

const ONLINE = {
  type: 'device.online',
  payload: { deviceId: 'd', deviceCode: '123456782' },
} as const;

describe('ConnectionRegistry', () => {
  it('routes to every socket of a user and to the current device socket', () => {
    const registry = new ConnectionRegistry();
    const a = fakeConnection('a', 'u1');
    const b = fakeConnection('b', 'u1', 'd1');
    const c = fakeConnection('c', 'u2');
    [a, b, c].forEach((conn) => registry.add(conn));

    expect(registry.sendToUser('u1', ONLINE)).toBe(2);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    expect(c.sent).toHaveLength(0);
    expect(registry.sendToDevice('d1', ONLINE)).toBe(true);
    expect(b.sent).toHaveLength(2);
    expect(registry.sendToDevice('missing', ONLINE)).toBe(false);
    expect(registry.sendToUser('nobody', ONLINE)).toBe(0);
  });

  it('replaces the device socket and only reports the current one as removed', () => {
    const registry = new ConnectionRegistry();
    const old = fakeConnection('old', 'u1', 'd1');
    const fresh = fakeConnection('new', 'u1', 'd1');
    registry.add(old);
    expect(registry.add(fresh)).toBe(old);
    expect(registry.remove(old)).toBe(false); // the stale socket closing must not mark d1 offline
    expect(registry.device('d1')).toBe(fresh);
    expect(registry.remove(fresh)).toBe(true);
    expect(registry.connectedDeviceIds()).toEqual([]);
    expect(registry.all.size).toBe(0);
  });

  it('skips sockets that are not open', () => {
    const registry = new ConnectionRegistry();
    const conn = fakeConnection('a', 'u1');
    (conn.socket as unknown as { readyState: number }).readyState = 3;
    registry.add(conn);
    registry.sendToUser('u1', ONLINE);
    expect(conn.sent).toEqual([]);
  });
});
