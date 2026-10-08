import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createSilentLogger } from '@remote-desktop/backend';
import {
  createTestHarness,
  type TestDevice,
  type TestHarness,
  type TestUser,
} from '@remote-desktop/backend/testing';
import {
  MAX_SIGNALING_FRAME_BYTES,
  SIGNALING_CLOSE_CODES,
  deviceAuthMessage,
  type ServerMessage,
  type ServerMessageType,
} from '@remote-desktop/webrtc';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  clientIp,
  createSignalingServer,
  type SignalingOptions,
  type SignalingServer,
} from './server';

/** Minimal test client: records every frame and lets tests await specific ones. */
class Client {
  readonly received: ServerMessage[] = [];
  private waiters: { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] =
    [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private seq = 0;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      this.received.push(message);
      this.waiters = this.waiters.filter((w) => {
        if (!w.match(message)) return true;
        w.resolve(message);
        return false;
      });
    });
    this.closed = new Promise((resolve) =>
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
  }

  next<T extends ServerMessageType>(
    type: T,
    predicate: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    timeoutMs = 5_000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const match = (m: ServerMessage) =>
      m.type === type && predicate(m as Extract<ServerMessage, { type: T }>);
    const existing = this.received.find(match);
    if (existing) {
      this.received.splice(this.received.indexOf(existing), 1);
      return Promise.resolve(existing as Extract<ServerMessage, { type: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          this.received.splice(this.received.indexOf(m), 1);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }

  sendRaw(data: string): void {
    this.ws.send(data);
  }

  /** Sends a request and resolves with its ack (or rejects with the error frame). */
  async request(type: string, payload: unknown): Promise<Record<string, unknown>> {
    const id = String(++this.seq);
    this.ws.send(JSON.stringify({ type, id, payload }));
    const reply = await Promise.race([
      this.next('ack', (m) => m.id === id),
      this.next('error', (m) => m.id === id),
    ]);
    if (reply.type === 'error') {
      throw Object.assign(new Error(reply.payload.message), { code: reply.payload.code });
    }
    return reply.payload;
  }

  close(): void {
    this.ws.close();
  }
}

let h: TestHarness;
let server: SignalingServer;
let url: string;
const clients: Client[] = [];

async function startServer(harness: TestHarness, overrides: Partial<SignalingOptions> = {}) {
  const instance = createSignalingServer({
    services: harness.services,
    limiters: harness.limiters,
    logger: createSilentLogger(),
    heartbeatIntervalMs: 60_000,
    presenceFlushIntervalMs: 60_000,
    expirySweepIntervalMs: 60_000,
    ...overrides,
  });
  const address = await instance.listen(0, '127.0.0.1');
  return { instance, url: `ws://127.0.0.1:${address.port}/ws` };
}

async function open(target = url): Promise<Client> {
  const ws = new WebSocket(target);
  const client = new Client(ws);
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return client;
}

/** Connects and authenticates as a user, optionally proving a device key. */
async function connect(user: TestUser, device?: TestDevice, target = url): Promise<Client> {
  const client = await open(target);
  const challenge = await client.next('auth.challenge');
  const payload: Record<string, unknown> = { accessToken: user.accessToken };
  if (device) {
    payload['device'] = {
      deviceId: device.record.id,
      signature: device.sign(deviceAuthMessage(challenge.payload.nonce, device.record.id)),
    };
  }
  client.sendRaw(JSON.stringify({ type: 'auth', id: 'auth', payload }));
  await client.next('auth.ok');
  return client;
}

async function expectError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

let owner: TestUser;
let operator: TestUser;
let stranger: TestUser;
let orgId: string;
let kiosk: TestDevice;
let operatorPc: TestDevice;

beforeAll(async () => {
  h = await createTestHarness();
  ({ instance: server, url } = await startServer(h));
  owner = await h.createUser('Owner');
  operator = await h.createUser('Operator');
  stranger = await h.createUser('Stranger');
  orgId = await h.createOrganization(owner);
  await h.addMember(orgId, operator, 'operator');
  kiosk = await h.registerDevice(owner, { name: 'Kiosk', organizationId: orgId });
  operatorPc = await h.registerDevice(operator, { name: 'Operator PC' });
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await h.db.query(
    `update public.connection_requests set status = 'cancelled' where status = 'pending'`,
  );
});

afterAll(async () => {
  await server.close();
  await h.close();
});

describe('WebSocket authentication', () => {
  it('sends a fresh challenge to every connection', async () => {
    const a = await open();
    const b = await open();
    const [ca, cb] = await Promise.all([a.next('auth.challenge'), b.next('auth.challenge')]);
    expect(ca.payload.nonce).not.toBe(cb.payload.nonce);
    expect(ca.payload.nonce.length).toBeGreaterThanOrEqual(40);
  });

  it('closes sockets that send anything before authenticating', async () => {
    const client = await open();
    client.sendRaw(
      JSON.stringify({ type: 'session.end', id: '1', payload: { sessionId: randomUUID() } }),
    );
    expect((await client.next('error')).payload.code).toBe('unauthenticated');
    expect((await client.closed).code).toBe(SIGNALING_CLOSE_CODES.authFailed);
  });

  it('rejects invalid tokens', async () => {
    const client = await open();
    await client.next('auth.challenge');
    client.sendRaw(
      JSON.stringify({ type: 'auth', id: '1', payload: { accessToken: 'x'.repeat(40) } }),
    );
    expect((await client.closed).code).toBe(SIGNALING_CLOSE_CODES.authFailed);
  });

  it('rejects a revoked (logged out) session token', async () => {
    const user = await h.createUser('LoggedOut');
    await h.authProvider.signOut(user.accessToken);
    const client = await open();
    await client.next('auth.challenge');
    client.sendRaw(
      JSON.stringify({ type: 'auth', id: '1', payload: { accessToken: user.accessToken } }),
    );
    expect((await client.closed).code).toBe(SIGNALING_CLOSE_CODES.authFailed);
  });

  it('times out sockets that never authenticate', async () => {
    const quick = await startServer(h, { authTimeoutMs: 100 });
    try {
      const client = await open(quick.url);
      expect((await client.closed).code).toBe(SIGNALING_CLOSE_CODES.authTimeout);
    } finally {
      await quick.instance.close();
    }
  });

  it('rejects a device signature over the wrong nonce', async () => {
    const client = await open();
    await client.next('auth.challenge');
    client.sendRaw(
      JSON.stringify({
        type: 'auth',
        id: '1',
        payload: {
          accessToken: owner.accessToken,
          device: {
            deviceId: kiosk.record.id,
            signature: kiosk.sign(deviceAuthMessage('old-nonce', kiosk.record.id)),
          },
        },
      }),
    );
    expect((await client.closed).code).toBe(SIGNALING_CLOSE_CODES.authFailed);
  });

  it('rejects claiming a device the user does not manage, even with its key', async () => {
    const client = await open();
    const challenge = await client.next('auth.challenge');
    client.sendRaw(
      JSON.stringify({
        type: 'auth',
        id: '1',
        payload: {
          accessToken: stranger.accessToken,
          device: {
            deviceId: kiosk.record.id,
            signature: kiosk.sign(deviceAuthMessage(challenge.payload.nonce, kiosk.record.id)),
          },
        },
      }),
    );
    expect((await client.closed).code).toBe(SIGNALING_CLOSE_CODES.authFailed);
  });

  it('binds the socket identity from the token and key, not the client', async () => {
    const client = await open();
    const challenge = await client.next('auth.challenge');
    client.sendRaw(
      JSON.stringify({
        type: 'auth',
        id: '1',
        payload: {
          accessToken: owner.accessToken,
          device: {
            deviceId: kiosk.record.id,
            signature: kiosk.sign(deviceAuthMessage(challenge.payload.nonce, kiosk.record.id)),
          },
        },
      }),
    );
    const ok = await client.next('auth.ok');
    expect(ok.payload).toEqual({
      userId: owner.id,
      deviceId: kiosk.record.id,
      deviceCode: kiosk.record.deviceCode,
    });
  });

  it('replaces an older socket for the same device', async () => {
    const first = await connect(owner, kiosk);
    await connect(owner, kiosk);
    expect((await first.closed).code).toBe(SIGNALING_CLOSE_CODES.replaced);
  });
});

describe('Phase 4 hardening', () => {
  it('closes a socket once its Supabase session is signed out', async () => {
    const user = await h.createUser('Leaver');
    const client = await connect(user);
    await server.recheckAuth();
    expect(client.ws.readyState).toBe(WebSocket.OPEN);

    // Logout / revocation removes the auth session; the token itself is still unexpired.
    await h.db.query('delete from auth.sessions where user_id = $1', [user.id]);
    await server.recheckAuth();
    const closed = await client.closed;
    expect(closed.code).toBe(SIGNALING_CLOSE_CODES.authFailed);
    expect(closed.reason).toBe('Signed out');
  });

  it('keeps sockets whose sign-in is still valid', async () => {
    const client = await connect(owner);
    await server.recheckAuth();
    await server.recheckAuth();
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('health probes expose status only', async () => {
    await connect(owner);
    const base = url.replace('ws://', 'http://').replace('/ws', '');
    const live = await fetch(`${base}/health`);
    expect(await live.json()).toEqual({ status: 'ok' });
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });
  });

  it('reports not-ready when its dependency fails', async () => {
    const { instance, url: other } = await startServer(h, {
      readinessCheck: () => Promise.reject(new Error('database down')),
    });
    const base = other.replace('ws://', 'http://').replace('/ws', '');
    const res = await fetch(`${base}/health/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unavailable' });
    await instance.close();
  });
});

describe('client IP behind a proxy', () => {
  const request = (xff: string | undefined, remote = '172.18.0.5') =>
    ({
      headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
      socket: { remoteAddress: remote },
    }) as unknown as IncomingMessage;

  it('uses the socket address when no proxy is trusted', () => {
    expect(clientIp(request('203.0.113.9'), 0)).toBe('172.18.0.5');
  });

  it('takes the entry appended by the trusted proxy, not a spoofed first entry', () => {
    expect(clientIp(request('1.1.1.1, 203.0.113.9'), 1)).toBe('203.0.113.9');
    expect(clientIp(request('203.0.113.9'), 1)).toBe('203.0.113.9');
  });

  it('falls back to the socket when the header is missing or too short', () => {
    expect(clientIp(request(undefined), 1)).toBe('172.18.0.5');
    expect(clientIp(request('203.0.113.9'), 2)).toBe('172.18.0.5');
  });
});

describe('message validation', () => {
  it('answers malformed frames with structured errors and keeps the socket', async () => {
    const client = await connect(operator);
    client.sendRaw('{not json');
    expect((await client.next('error')).payload.code).toBe('invalid_message');
    client.sendRaw(
      JSON.stringify({
        type: 'webrtc.offer',
        id: '9',
        payload: { sessionId: randomUUID(), sdp: 'v=0', userId: owner.id },
      }),
    );
    const smuggled = await client.next('error');
    expect(smuggled).toMatchObject({ id: '9', payload: { code: 'invalid_message' } });
    await expectError(client.request('session.end', { sessionId: randomUUID() }), 'not_found');
  });

  it('closes after too many invalid frames', async () => {
    const client = await connect(operator);
    for (let i = 0; i < 10; i++) client.sendRaw('nope');
    expect((await client.closed).code).toBe(SIGNALING_CLOSE_CODES.protocolError);
  });

  it('rejects oversized frames at the transport', async () => {
    const client = await connect(operator);
    client.sendRaw('x'.repeat(MAX_SIGNALING_FRAME_BYTES + 1));
    expect((await client.closed).code).toBe(1009);
  });
});

describe('connection flow', () => {
  it('requests, approves, relays WebRTC negotiation, updates permissions and ends', async () => {
    const remote = await connect(owner, kiosk);
    const controller = await connect(operator, operatorPc);

    const requested = await controller.request('connection.request', {
      targetDeviceCode: kiosk.record.deviceCode,
      permissions: ['screen_view', 'mouse', 'keyboard', 'remote_control'],
      message: 'IT support',
    });
    expect(requested).toMatchObject({
      state: 'APPROVAL_PENDING',
      autoApproved: false,
      targetOnline: true,
    });

    const incoming = await remote.next('connection.request');
    expect(incoming.payload).toMatchObject({
      requestId: requested['requestId'],
      sessionId: requested['sessionId'],
      controller: {
        userId: operator.id,
        displayName: 'Operator',
        deviceCode: operatorPc.record.deviceCode,
      },
      message: 'IT support',
    });

    // The controller cannot approve its own request.
    await expectError(
      controller.request('connection.approve', { requestId: incoming.payload.requestId }),
      'not_found',
    );

    const approved = await remote.request('connection.approve', {
      requestId: incoming.payload.requestId,
      permissions: ['screen_view', 'keyboard', 'remote_control'],
    });
    expect(approved).toMatchObject({ state: 'SIGNALING' });
    const notice = await controller.next('connection.approve');
    expect(notice.payload.permissions).toEqual(['screen_view', 'keyboard', 'remote_control']);

    const sessionId = incoming.payload.sessionId;
    expect(await controller.request('webrtc.offer', { sessionId, sdp: 'v=0 offer' })).toMatchObject(
      { state: 'CONNECTING' },
    );
    expect((await remote.next('webrtc.offer')).payload).toEqual({ sessionId, sdp: 'v=0 offer' });

    await remote.request('webrtc.answer', { sessionId, sdp: 'v=0 answer' });
    expect((await controller.next('webrtc.answer')).payload.sdp).toBe('v=0 answer');

    const candidate = {
      candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    await controller.request('webrtc.ice_candidate', { sessionId, candidate });
    expect((await remote.next('webrtc.ice_candidate')).payload.candidate).toEqual(candidate);

    // Roles are fixed server-side: the remote cannot send offers, the controller cannot answer.
    await expectError(remote.request('webrtc.offer', { sessionId, sdp: 'v=0' }), 'forbidden');
    await expectError(controller.request('webrtc.answer', { sessionId, sdp: 'v=0' }), 'forbidden');

    // Only the remote may change permissions, and the operator ceiling still applies.
    await expectError(
      controller.request('session.permission_update', { sessionId, permissions: ['screen_view'] }),
      'forbidden',
    );
    const updated = await remote.request('session.permission_update', {
      sessionId,
      permissions: ['screen_view', 'file_transfer'],
    });
    expect(updated['permissions']).toEqual(['screen_view']);
    expect((await controller.next('session.permission_update')).payload.permissions).toEqual([
      'screen_view',
    ]);

    // An outsider cannot touch the session, even knowing its id.
    const outsider = await connect(stranger);
    await expectError(
      outsider.request('webrtc.offer', { sessionId, sdp: 'v=0 evil' }),
      'not_found',
    );
    await expectError(outsider.request('session.end', { sessionId }), 'not_found');

    expect(await controller.request('session.end', { sessionId, reason: 'done' })).toMatchObject({
      state: 'ENDED',
    });
    expect((await remote.next('session.end')).payload).toMatchObject({
      sessionId,
      state: 'ENDED',
      reason: 'done',
    });
    await expectError(
      controller.request('webrtc.offer', { sessionId, sdp: 'v=0' }),
      'invalid_state',
    );

    const actions = (
      await h.db.query<{ action: string }>('select action::text from public.audit_logs')
    ).map((r) => r.action);
    for (const action of [
      'CONNECTION_REQUESTED',
      'CONNECTION_APPROVED',
      'PERMISSION_CHANGED',
      'SESSION_ENDED',
    ]) {
      expect(actions).toContain(action);
    }
    const audit = JSON.stringify(await h.db.query('select metadata from public.audit_logs'));
    expect(audit).not.toContain('v=0');
    expect(audit).not.toContain('candidate:1');
  });

  it('relays rejection to the controller', async () => {
    const remote = await connect(owner, kiosk);
    const controller = await connect(operator, operatorPc);
    const requested = await controller.request('connection.request', {
      targetDeviceCode: kiosk.record.deviceCode,
      permissions: ['screen_view'],
    });
    const incoming = await remote.next('connection.request');
    expect(
      await remote.request('connection.reject', {
        requestId: incoming.payload.requestId,
        reason: 'busy',
      }),
    ).toMatchObject({ state: 'FAILED' });
    expect((await controller.next('connection.reject')).payload).toEqual({
      requestId: requested['requestId'],
      sessionId: requested['sessionId'],
      reason: 'busy',
    });
  });

  it('only accepts approval from the target device socket', async () => {
    await connect(owner, kiosk);
    const ownerWithoutDevice = await connect(owner);
    const controller = await connect(operator, operatorPc);
    const requested = await controller.request('connection.request', {
      targetDeviceCode: kiosk.record.deviceCode,
      permissions: ['screen_view'],
    });
    await expectError(
      ownerWithoutDevice.request('connection.approve', { requestId: requested['requestId'] }),
      'not_found',
    );
  });

  it('refuses requests beyond the caller’s permissions or to invisible devices', async () => {
    const controller = await connect(operator, operatorPc);
    await expectError(
      controller.request('connection.request', {
        targetDeviceCode: kiosk.record.deviceCode,
        permissions: ['screen_view', 'audio'],
      }),
      'forbidden',
    );
    const outsider = await connect(stranger);
    await expectError(
      outsider.request('connection.request', {
        targetDeviceCode: kiosk.record.deviceCode,
        permissions: ['screen_view'],
      }),
      'not_found',
    );
  });

  it('tells both sides when a pending request expires', async () => {
    const remote = await connect(owner, kiosk);
    const controller = await connect(operator, operatorPc);
    const requested = await controller.request('connection.request', {
      targetDeviceCode: kiosk.record.deviceCode,
      permissions: ['screen_view'],
    });
    await remote.next('connection.request');
    await h.db.exec(
      'alter table public.connection_requests disable trigger enforce_connection_request_transition',
    );
    await h.db.query(
      `update public.connection_requests set created_at = now() - interval '2 minutes',
              expires_at = now() - interval '1 second' where id = $1`,
      [requested['requestId']],
    );
    await h.db.exec(
      'alter table public.connection_requests enable trigger enforce_connection_request_transition',
    );
    await server.sweepExpired();
    const expected = { sessionId: requested['sessionId'], state: 'EXPIRED', reason: 'expired' };
    expect((await controller.next('session.end')).payload).toEqual(expected);
    expect((await remote.next('session.end')).payload).toEqual(expected);
  });
});

describe('presence', () => {
  it('announces online/offline to the device audience and stores it', async () => {
    const watcher = await connect(owner);
    const device = await connect(owner, kiosk);
    expect((await watcher.next('device.online')).payload).toEqual({
      deviceId: kiosk.record.id,
      deviceCode: kiosk.record.deviceCode,
    });
    expect((await h.services.devices.get(owner.id, kiosk.record.id)).status).toBe('online');

    const outsider = await connect(stranger);
    device.close();
    const offline = await watcher.next('device.offline');
    expect(offline.payload.deviceId).toBe(kiosk.record.id);
    expect((await h.services.devices.get(owner.id, kiosk.record.id)).status).toBe('offline');
    expect(outsider.received.filter((m) => m.type.startsWith('device.'))).toEqual([]);
  });

  it('writes last_seen_at in one batch per flush, not per heartbeat', async () => {
    const fast = await startServer(h, { heartbeatIntervalMs: 50 });
    try {
      await connect(owner, kiosk, fast.url);
      const before = await h.db.query<{ last_seen_at: Date }>(
        'select last_seen_at from public.devices where id = $1',
        [kiosk.record.id],
      );
      await new Promise((resolve) => setTimeout(resolve, 300)); // several heartbeats
      const during = await h.db.query<{ last_seen_at: Date }>(
        'select last_seen_at from public.devices where id = $1',
        [kiosk.record.id],
      );
      expect(during[0]?.last_seen_at.getTime()).toBe(before[0]?.last_seen_at.getTime());
      await fast.instance.flushPresence();
      const after = await h.db.query<{ last_seen_at: Date }>(
        'select last_seen_at from public.devices where id = $1',
        [kiosk.record.id],
      );
      expect(after[0]?.last_seen_at.getTime()).toBeGreaterThan(
        before[0]?.last_seen_at.getTime() ?? 0,
      );
    } finally {
      await fast.instance.close();
    }
  });

  it('terminates sockets that stop answering heartbeats', async () => {
    const fast = await startServer(h, { heartbeatIntervalMs: 50 });
    try {
      const client = await connect(operator, undefined, fast.url);
      // Stop answering pings: ws auto-pongs, so pause the underlying socket.
      (client.ws as unknown as { _socket: { pause(): void } })._socket.pause();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(fast.instance.registry.all.size).toBe(0);
    } finally {
      await fast.instance.close();
    }
  });

  it('disconnects a device revoked through the API', async () => {
    const temp = await h.registerDevice(owner, { name: 'Temp' });
    const client = await connect(owner, temp);
    await h.services.devices.revoke(owner.id, temp.record.id, { ip: null });
    await server.flushPresence();
    expect((await client.closed).reason).toBe('Device revoked');
  });
});

describe('rate limiting', () => {
  it('closes a connection that floods messages', async () => {
    const strict = await createTestHarness({ rateLimitMultiplier: 0.05 });
    const instance = await startServer(strict);
    try {
      const user = await strict.createUser('Flood');
      const client = await connect(user, undefined, instance.url);
      for (let i = 0; i < 20; i++) {
        client.sendRaw(
          JSON.stringify({
            type: 'session.end',
            id: String(i),
            payload: { sessionId: randomUUID() },
          }),
        );
      }
      expect((await client.closed).code).toBe(SIGNALING_CLOSE_CODES.rateLimited);
    } finally {
      await instance.instance.close();
      await strict.close();
    }
  });

  it('refuses WebSocket upgrades from an IP over its auth budget', async () => {
    const strict = await createTestHarness({ rateLimitMultiplier: 0.1 }); // 3 per minute
    const instance = await startServer(strict);
    try {
      const results: string[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(
          await new Promise<string>((resolve) => {
            const ws = new WebSocket(instance.url);
            ws.once('open', () => {
              ws.close();
              resolve('open');
            });
            ws.once('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
            ws.once('error', () => resolve('error'));
          }),
        );
      }
      expect(results.slice(0, 3)).toEqual(['open', 'open', 'open']);
      expect(results.slice(3)).toEqual(['429', '429']);
    } finally {
      await instance.instance.close();
      await strict.close();
    }
  });
});

describe('phase 3 session support', () => {
  const ICE = {
    stunUrls: ['stun:127.0.0.1:3478'],
    turnUrls: ['turn:127.0.0.1:3478?transport=udp'],
    turnSecret: 'test-turn-secret-that-is-long-enough-000',
    ttlSeconds: 600,
  };

  async function approvedSession(target: string) {
    const remote = await connect(owner, kiosk, target);
    const controller = await connect(operator, operatorPc, target);
    const requested = await controller.request('connection.request', {
      targetDeviceCode: kiosk.record.deviceCode,
      permissions: ['screen_view', 'clipboard'],
    });
    const incoming = await remote.next('connection.request');
    await remote.request('connection.approve', { requestId: incoming.payload.requestId });
    return { remote, controller, sessionId: String(requested['sessionId']) };
  }

  it('issues per-user TURN credentials only after approval', async () => {
    const server = await startServer(h, { ice: ICE });
    try {
      const remote = await connect(owner, kiosk, server.url);
      const controller = await connect(operator, operatorPc, server.url);
      await controller.request('connection.request', {
        targetDeviceCode: kiosk.record.deviceCode,
        permissions: ['screen_view'],
      });
      const incoming = await remote.next('connection.request');
      // Nothing yet: a pending request grants no relay access.
      expect(controller.received.some((m) => m.type === 'session.ice_config')).toBe(false);
      await remote.request('connection.approve', { requestId: incoming.payload.requestId });
      const [forController, forHost] = await Promise.all([
        controller.next('session.ice_config'),
        remote.next('session.ice_config'),
      ]);
      const turnFor = (m: typeof forController) => m.payload.iceServers.find((s) => s.username);
      expect(turnFor(forController)?.username).toMatch(new RegExp(`:${operator.id}$`));
      expect(turnFor(forHost)?.username).toMatch(new RegExp(`:${owner.id}$`));
      expect(forController.payload.iceServers[0]?.urls).toEqual(ICE.stunUrls);
      // The approve notice reaches the controller after its ICE config.
      await controller.next('connection.approve');
    } finally {
      await server.instance.close();
    }
  });

  it('verifies, reports and audits through the socket', async () => {
    const { remote, controller, sessionId } = await approvedSession(url);
    const verified = await remote.request('session.verify', { sessionId });
    expect(verified).toMatchObject({ ended: false, permissions: ['screen_view', 'clipboard'] });
    await controller.request('webrtc.offer', { sessionId, sdp: 'v=0' });
    expect(
      await controller.request('session.report', { sessionId, state: 'CONNECTED' }),
    ).toMatchObject({
      state: 'CONNECTED',
    });
    await controller.request('session.audit', {
      sessionId,
      event: 'CLIPBOARD_TRANSFERRED',
      direction: 'controller_to_host',
      bytes: 3,
    });
    await expectError(
      controller.request('session.audit', {
        sessionId,
        event: 'FILE_TRANSFER_STARTED',
        direction: 'controller_to_host',
        bytes: 3,
      }),
      'forbidden',
    );
    const outsider = await connect(stranger);
    await expectError(outsider.request('session.verify', { sessionId }), 'not_found');
    await controller.request('session.end', { sessionId });
  });

  it('fails sessions of a participant that stays disconnected, and tells the other side', async () => {
    const server = await startServer(h, { peerDisconnectGraceMs: 150 });
    try {
      const { remote, controller, sessionId } = await approvedSession(server.url);
      remote.close();
      const notice = await controller.next('session.end', (m) => m.payload.sessionId === sessionId);
      expect(notice.payload).toMatchObject({ state: 'FAILED', reason: 'peer_disconnected' });
      expect((await h.services.sessions.get(operator.id, sessionId)).state).toBe('FAILED');
    } finally {
      await server.instance.close();
    }
  });

  it('keeps sessions when the participant reconnects within the grace period', async () => {
    const server = await startServer(h, { peerDisconnectGraceMs: 400 });
    try {
      const { remote, controller, sessionId } = await approvedSession(server.url);
      remote.close();
      await remote.closed;
      await connect(owner, kiosk, server.url);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect((await h.services.sessions.get(operator.id, sessionId)).state).toBe('SIGNALING');
      await controller.request('session.end', { sessionId });
    } finally {
      await server.instance.close();
    }
  });

  it('expires approved sessions that never connect', async () => {
    const { remote, controller, sessionId } = await approvedSession(url);
    await h.db.exec('alter table public.sessions disable trigger set_updated_at');
    await h.db.query(
      `update public.sessions set updated_at = now() - interval '10 minutes' where id = $1`,
      [sessionId],
    );
    await h.db.exec('alter table public.sessions enable trigger set_updated_at');
    await server.sweepExpired();
    const expected = { sessionId, state: 'EXPIRED', reason: 'authorization_expired' };
    expect(
      (await controller.next('session.end', (m) => m.payload.sessionId === sessionId)).payload,
    ).toEqual(expected);
    expect(
      (await remote.next('session.end', (m) => m.payload.sessionId === sessionId)).payload,
    ).toEqual(expected);
    // Expired means expired: no more signaling for it.
    await expectError(
      controller.request('webrtc.offer', { sessionId, sdp: 'v=0' }),
      'invalid_state',
    );
  });
});

describe('start-up reconciliation', () => {
  it('ends live sessions whose participants do not return after a restart', async () => {
    const first = await startServer(h);
    const remote = await connect(owner, kiosk, first.url);
    const controller = await connect(operator, operatorPc, first.url);
    const requested = await controller.request('connection.request', {
      targetDeviceCode: kiosk.record.deviceCode,
      permissions: ['screen_view'],
    });
    const incoming = await remote.next('connection.request');
    await remote.request('connection.approve', { requestId: incoming.payload.requestId });
    const sessionId = String(requested['sessionId']);
    // The instance goes away; its sockets close but it must not end sessions itself.
    await first.instance.close();
    expect((await h.services.sessions.get(operator.id, sessionId)).state).toBe('SIGNALING');

    // A new instance: only the controller comes back.
    const second = await startServer(h, { reconcileOnStart: true, peerDisconnectGraceMs: 300 });
    try {
      const back = await connect(operator, operatorPc, second.url);
      const notice = await back.next('session.end', (m) => m.payload.sessionId === sessionId);
      expect(notice.payload).toMatchObject({ state: 'FAILED', reason: 'peer_disconnected' });
    } finally {
      await second.instance.close();
    }
  });
});
