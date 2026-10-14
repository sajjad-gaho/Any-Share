import {
  generateDeviceKeys,
  createTestHarness,
  type TestHarness,
  type TestUser,
} from '@remote-desktop/backend/testing';
import { createSilentLogger } from '@remote-desktop/backend';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

let h: TestHarness;
let app: FastifyInstance;

async function build(rateLimitMultiplier: number): Promise<FastifyInstance> {
  return buildApp({
    services: h.services,
    limiters: h.limiters,
    db: h.db,
    logger: createSilentLogger(),
    trustProxy: 0,
    rateLimitMultiplier,
  });
}

const auth = (user: TestUser) => ({ authorization: `Bearer ${user.accessToken}` });
const errorCode = (res: LightMyRequestResponse) =>
  (res.json() as { error: { code: string } }).error.code;

function newDeviceBody(name = 'Workstation') {
  return {
    name,
    os: { family: 'windows', version: 'Windows 11 24H2' },
    publicKey: generateDeviceKeys().publicKey,
  };
}

beforeAll(async () => {
  h = await createTestHarness();
  app = await build(100);
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('health', () => {
  it('reports liveness and readiness', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).json()).toEqual({
      status: 'ready',
    });
  });

  it('sets no-store and nosniff headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves the probes under /api/v1 too', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).json()).toEqual({
      status: 'ok',
    });
    expect((await app.inject({ method: 'GET', url: '/api/v1/health/ready' })).json()).toEqual({
      status: 'ready',
    });
  });

  it('sends hardening headers and a server-generated request id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'attacker-chosen' },
    });
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-request-id']).not.toBe('attacker-chosen');
  });

  it('sends no CORS headers, so browsers block cross-origin reads', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('client IP behind a proxy', () => {
  it('ignores X-Forwarded-For without a trusted proxy', async () => {
    const direct = await build(100);
    direct.get('/ip', async (request) => ({ ip: request.ip }));
    const res = await direct.inject({
      method: 'GET',
      url: '/ip',
      headers: { 'x-forwarded-for': '203.0.113.9' },
      remoteAddress: '198.51.100.7',
    });
    expect(res.json()).toEqual({ ip: '198.51.100.7' });
    await direct.close();
  });

  it('takes the address the trusted proxy appended, not a spoofed one', async () => {
    const proxied = await buildApp({
      services: h.services,
      limiters: h.limiters,
      db: h.db,
      logger: createSilentLogger(),
      trustProxy: 1,
      rateLimitMultiplier: 100,
    });
    proxied.get('/ip', async (request) => ({ ip: request.ip }));
    // Client sent "1.1.1.1"; the single trusted proxy appended the real address.
    const res = await proxied.inject({
      method: 'GET',
      url: '/ip',
      headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.9' },
      remoteAddress: '172.18.0.5',
    });
    expect(res.json()).toEqual({ ip: '203.0.113.9' });
    await proxied.close();
  });
});

describe('auth routes', () => {
  it('registers, logs in, restores the session and logs out', async () => {
    const credentials = { email: 'grace@example.test', password: 'a very long password' };
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { ...credentials, displayName: 'Grace' },
    });
    expect(registered.statusCode).toBe(201);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: credentials,
    });
    expect(login.statusCode).toBe(200);
    const { tokens } = login.json() as { tokens: { accessToken: string; refreshToken: string } };

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(me.json()).toMatchObject({
      email: 'grace@example.test',
      displayName: 'Grace',
      memberships: [],
    });

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    const fresh = (refreshed.json() as { tokens: { accessToken: string } }).tokens.accessToken;

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${fresh}` },
    });
    expect(logout.statusCode).toBe(204);
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${fresh}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('answers wrong passwords with a generic 401', async () => {
    const user = await h.createUser('Wrong');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: 'nope' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Invalid email or password' },
    });
  });

  it('validates input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'not-an-email', password: 'x', displayName: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('bad_request');
  });

  it('confirms a new account with the emailed code instead of a link', async () => {
    h.authProvider.confirmSignups = true;
    try {
      const credentials = { email: 'ada@example.test', password: 'a very long password' };
      const registered = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { ...credentials, displayName: 'Ada' },
      });
      expect(registered.statusCode).toBe(201);
      expect((registered.json() as { tokens: unknown }).tokens).toBeNull();

      const early = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: credentials,
      });
      expect(early.statusCode).toBe(403);
      expect(errorCode(early)).toBe('email_not_confirmed');

      const wrong = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register/verify',
        payload: { email: credentials.email, code: '000000' },
      });
      expect(wrong.statusCode).toBe(401);

      for (const email of [credentials.email, 'nobody@example.test']) {
        const resend = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register/resend',
          payload: { email },
        });
        expect(resend.statusCode).toBe(202);
        expect(resend.json()).toEqual({ status: 'sent_if_registered' });
      }

      const code = h.authProvider.signupCodeFor(credentials.email);
      expect(code).toMatch(/^\d{6}$/);
      const verified = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register/verify',
        payload: { email: 'ADA@example.test', code },
      });
      expect(verified.statusCode).toBe(200);
      const { tokens } = verified.json() as { tokens: { accessToken: string } };
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });
      expect(me.json()).toMatchObject({ email: credentials.email, displayName: 'Ada' });

      // The code is single-use, and a confirmed account signs in normally.
      const again = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register/verify',
        payload: { email: credentials.email, code },
      });
      expect(again.statusCode).toBe(401);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: credentials,
      });
      expect(login.statusCode).toBe(200);
    } finally {
      h.authProvider.confirmSignups = false;
    }
  });

  it('never reveals whether an email is registered on password reset', async () => {
    const user = await h.createUser('Forgetful');
    for (const email of [user.email, 'nobody@example.test']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset',
        payload: { email },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: 'sent_if_registered' });
    }
  });
});

describe('authentication guard', () => {
  it.each([
    ['no header', {}],
    ['wrong scheme', { authorization: 'Basic abc' }],
    ['garbage token', { authorization: 'Bearer this.is.not-a-jwt-at-all' }],
  ])('rejects %s', async (_label, headers) => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/devices', headers });
    expect(res.statusCode).toBe(401);
  });
});

describe('device API', () => {
  let alice: TestUser;
  let bob: TestUser;
  let deviceId: string;

  beforeAll(async () => {
    alice = await h.createUser('Alice');
    bob = await h.createUser('Bob');
  });

  it('POST registers a device owned by the caller', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: auth(alice),
      payload: newDeviceBody(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; ownerId: string; deviceCode: string };
    expect(body.ownerId).toBe(alice.id);
    expect(body.deviceCode).toMatch(/^\d{9}$/);
    expect(JSON.stringify(body)).not.toMatch(/publicKey|secret/);
    deviceId = body.id;
  });

  it('ignores a client-supplied owner', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: auth(bob),
      payload: { ...newDeviceBody('Sneaky'), ownerId: alice.id },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { ownerId: string }).ownerId).toBe(bob.id);
  });

  it('GET lists and fetches only the caller’s devices', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(alice) });
    expect((list.json() as { id: string }[]).map((d) => d.id)).toEqual([deviceId]);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/devices/${deviceId}`,
          headers: auth(alice),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/devices/${deviceId}`, headers: auth(bob) }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/devices/not-a-uuid', headers: auth(alice) }))
        .statusCode,
    ).toBe(400);
  });

  it('GET /:id/access returns the server-computed access', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceId}/access`,
      headers: auth(alice),
    });
    expect(res.json()).toMatchObject({
      relation: 'owner',
      canManage: true,
      requireApproval: false,
    });
  });

  it('PATCH updates allowed fields and rejects unknown ones', async () => {
    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(alice),
      payload: { name: 'Renamed', accessPassword: 'unattended pw 1' },
    });
    expect(ok.json()).toMatchObject({ name: 'Renamed', hasAccessPassword: true });
    const sneaky = await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(alice),
      payload: { ownerId: bob.id },
    });
    expect(sneaky.statusCode).toBe(400);
    const foreign = await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceId}`,
      headers: auth(bob),
      payload: { name: 'Mine now' },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('DELETE revokes for the owner only', async () => {
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/devices/${deviceId}`,
          headers: auth(bob),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/devices/${deviceId}`,
          headers: auth(alice),
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/devices/${deviceId}`,
          headers: auth(alice),
        })
      ).json(),
    ).toMatchObject({
      revokedAt: expect.any(String),
      status: 'offline',
    });
  });
});

describe('organizations, RBAC and device permissions', () => {
  let owner: TestUser;
  let operator: TestUser;
  let member: TestUser;
  let orgId: string;
  let deviceId: string;

  beforeAll(async () => {
    owner = await h.createUser('Owner');
    operator = await h.createUser('Operator');
    member = await h.createUser('Member');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: auth(owner),
      payload: { name: 'Acme', slug: 'acme-api' },
    });
    orgId = (created.json() as { id: string }).id;
    for (const [user, role] of [
      [operator, 'operator'],
      [member, 'user'],
    ] as const) {
      const added = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${orgId}/members`,
        headers: auth(owner),
        payload: { email: user.email, role },
      });
      expect(added.statusCode).toBe(201);
    }
    const device = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: auth(owner),
      payload: { ...newDeviceBody('Kiosk'), organizationId: orgId },
    });
    deviceId = (device.json() as { id: string }).id;
  });

  it('returns roles from the database', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/organizations',
      headers: auth(operator),
    });
    expect(res.json()).toEqual([expect.objectContaining({ id: orgId, role: 'operator' })]);
  });

  it('forbids operators from managing members or device permissions', async () => {
    const add = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${orgId}/members`,
      headers: auth(operator),
      payload: { email: member.email, role: 'admin' },
    });
    expect(add.statusCode).toBe(403);
    const grant = await app.inject({
      method: 'PUT',
      url: `/api/v1/devices/${deviceId}/permissions/${member.id}`,
      headers: auth(operator),
      payload: { permissions: ['screen_view'] },
    });
    expect(grant.statusCode).toBe(403);
  });

  it('lets the owner grant a plain user access, which unlocks the device for them', async () => {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/devices/${deviceId}`,
          headers: auth(member),
        })
      ).statusCode,
    ).toBe(404);
    const grant = await app.inject({
      method: 'PUT',
      url: `/api/v1/devices/${deviceId}/permissions/${member.id}`,
      headers: auth(owner),
      payload: { permissions: ['screen_view', 'clipboard'], requireApproval: true },
    });
    expect(grant.json()).toMatchObject({
      permissions: ['screen_view', 'clipboard'],
      requireApproval: true,
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/devices/${deviceId}`,
          headers: auth(member),
        })
      ).statusCode,
    ).toBe(200);
    const access = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceId}/access`,
      headers: auth(member),
    });
    expect(access.json()).toMatchObject({
      relation: 'grant',
      permissions: ['screen_view', 'clipboard'],
    });

    const bad = await app.inject({
      method: 'PUT',
      url: `/api/v1/devices/${deviceId}/permissions/${member.id}`,
      headers: auth(owner),
      payload: { permissions: ['keyboard'] },
    });
    expect(bad.statusCode).toBe(400);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${deviceId}/permissions`,
      headers: auth(owner),
    });
    expect((listed.json() as unknown[]).length).toBe(1);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/devices/${deviceId}/permissions/${member.id}`,
          headers: auth(owner),
        })
      ).statusCode,
    ).toBe(204);
  });

  it('shows organisation audit logs to the owner only', async () => {
    const own = await app.inject({
      method: 'GET',
      url: `/api/v1/audit-logs?organizationId=${orgId}`,
      headers: auth(owner),
    });
    const actions = (own.json() as { action: string }[]).map((e) => e.action);
    expect(actions).toContain('DEVICE_REGISTERED');
    expect(actions).toContain('PERMISSION_CHANGED');
    const op = await app.inject({
      method: 'GET',
      url: `/api/v1/audit-logs?organizationId=${orgId}`,
      headers: auth(operator),
    });
    expect(op.json()).toEqual([]);
  });

  it('lists and cancels connection requests; reads sessions', async () => {
    const created = await h.services.connections.create(
      { userId: operator.id, deviceId: null },
      {
        targetDeviceCode: (await h.services.devices.get(owner.id, deviceId)).deviceCode,
        permissions: ['screen_view'],
      },
      { ip: null },
    );
    const incoming = await app.inject({
      method: 'GET',
      url: '/api/v1/connection-requests?direction=incoming&status=pending',
      headers: auth(owner),
    });
    expect((incoming.json() as { id: string }[]).map((r) => r.id)).toEqual([created.request.id]);
    const notMine = await app.inject({
      method: 'POST',
      url: `/api/v1/connection-requests/${created.request.id}/cancel`,
      headers: auth(member),
    });
    expect(notMine.statusCode).toBe(404);
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/connection-requests/${created.request.id}/cancel`,
      headers: auth(operator),
    });
    expect(cancelled.json()).toMatchObject({ status: 'cancelled' });
    const session = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${created.session.id}`,
      headers: auth(operator),
    });
    expect(session.json()).toMatchObject({ state: 'ENDED' });
    const hidden = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${created.session.id}`,
      headers: auth(member),
    });
    expect(hidden.statusCode).toBe(404);
  });

  it('rejects invalid session state reports', async () => {
    const created = await h.services.connections.create(
      { userId: operator.id, deviceId: null },
      {
        targetDeviceCode: (await h.services.devices.get(owner.id, deviceId)).deviceCode,
        permissions: ['screen_view'],
      },
      { ip: null },
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${created.session.id}/state`,
      headers: auth(operator),
      payload: { state: 'CONNECTED' },
    });
    expect(res.statusCode).toBe(409);
    const notReportable = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${created.session.id}/state`,
      headers: auth(operator),
      payload: { state: 'SIGNALING' },
    });
    expect(notReportable.statusCode).toBe(400);
    const ended = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${created.session.id}/end`,
      headers: auth(operator),
      payload: {},
    });
    expect(ended.json()).toMatchObject({ state: 'ENDED' });
  });
});

describe('malformed requests', () => {
  it('rejects invalid JSON and oversized bodies', async () => {
    const user = await h.createUser('Malformed');
    const badJson = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: { ...auth(user), 'content-type': 'application/json' },
      payload: '{"name": ',
    });
    expect(badJson.statusCode).toBe(400);
    const huge = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: { ...auth(user), 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x'.repeat(70_000) }),
    });
    expect(huge.statusCode).toBe(413);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBe('not_found');
  });
});

describe('rate limiting and brute-force protection', () => {
  it('locks out an IP after repeated failed logins, with Retry-After', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: `nobody${i}@example.test`, password: 'x' },
        remoteAddress: '192.0.2.50',
      });
      statuses.push(res.statusCode);
      if (res.statusCode === 429) {
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        expect(errorCode(res)).toBe('rate_limited');
      }
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    // Other sources are unaffected.
    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@example.test', password: 'x' },
      remoteAddress: '192.0.2.51',
    });
    expect(other.statusCode).toBe(401);
  });

  it('applies per-route HTTP budgets to sensitive endpoints', async () => {
    const strict = await build(1);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        const res = await strict.inject({
          method: 'POST',
          url: '/api/v1/auth/password-reset',
          payload: { email: 'someone@example.test' },
          remoteAddress: '192.0.2.60',
        });
        statuses.push(res.statusCode);
      }
      expect(statuses).toEqual([202, 202, 202, 202, 202, 429, 429]);
    } finally {
      await strict.close();
    }
  });

  it('limits device registration per user', async () => {
    const user = await h.createUser('Registrar');
    // Exhaust this user's budget; the route must consult it before registering.
    h.limiters.deviceRegistration.consume(`user:${user.id}`, 1_000_000);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: auth(user),
      payload: newDeviceBody('One too many'),
    });
    expect(res.statusCode).toBe(429);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/devices', headers: auth(user) })).json(),
    ).toEqual([]);
  });
});
