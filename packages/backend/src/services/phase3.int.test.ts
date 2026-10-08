import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser } from '../db/types';
import { AppError } from '../errors';
import { buildIceServers } from '../security/turn';
import { createTestHarness, type TestDevice, type TestHarness, type TestUser } from '../testing';

const META = { ip: '203.0.113.20' };

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return error instanceof AppError ? error.code : String(error);
}

let h: TestHarness;
let owner: TestUser;
let operator: TestUser;
let stranger: TestUser;
let orgId: string;
let kiosk: TestDevice;
let operatorPc: TestDevice;

beforeAll(async () => {
  h = await createTestHarness();
  owner = await h.createUser('Owner');
  operator = await h.createUser('Operator');
  stranger = await h.createUser('Stranger');
  orgId = await h.createOrganization(owner);
  await h.addMember(orgId, operator, 'operator');
  kiosk = await h.registerDevice(owner, { name: 'Kiosk', organizationId: orgId });
  operatorPc = await h.registerDevice(operator, { name: 'Operator PC' });
});

afterAll(() => h.close());

const remote = () => ({ userId: owner.id, deviceId: kiosk.record.id });
const controller = () => ({ userId: operator.id, deviceId: operatorPc.record.id });

async function connectedSession(
  permissions: ('screen_view' | 'mouse' | 'keyboard' | 'clipboard' | 'remote_control')[],
) {
  await h.db.query(
    `update public.connection_requests set status = 'cancelled' where status = 'pending'`,
  );
  const created = await h.services.connections.create(
    controller(),
    { targetDeviceCode: kiosk.record.deviceCode, permissions },
    META,
  );
  await h.services.connections.approve(remote(), created.request.id, undefined, META);
  await h.services.sessions.authorizeRelay(controller(), created.session.id, 'offer');
  await h.services.sessions.reportState(
    controller(),
    created.session.id,
    { state: 'CONNECTED' },
    META,
  );
  return created.session.id;
}

describe('session.verify (short-lived authorization)', () => {
  it('confirms a healthy session for both participants', async () => {
    const sessionId = await connectedSession(['screen_view', 'clipboard']);
    const host = await h.services.sessions.verify(remote(), sessionId, META);
    expect(host).toMatchObject({ side: 'target', ended: false });
    expect(host.session.permissions).toEqual(['screen_view', 'clipboard']);
    expect((await h.services.sessions.verify(controller(), sessionId, META)).side).toBe(
      'controller',
    );
    expect(
      await errorCode(
        h.services.sessions.verify({ userId: stranger.id, deviceId: null }, sessionId, META),
      ),
    ).toBe('not_found');
    await h.services.sessions.end(remote(), sessionId, 'done', META);
    expect((await h.services.sessions.verify(remote(), sessionId, META)).ended).toBe(true);
  });

  it('narrows permissions when the controller ceiling shrinks', async () => {
    const sessionId = await connectedSession([
      'screen_view',
      'mouse',
      'remote_control',
      'clipboard',
    ]);
    // Restrict the operator to view-only on this device.
    await h.services.permissions.setDevicePermission(
      owner.id,
      kiosk.record.id,
      { userId: operator.id, permissions: ['screen_view'], requireApproval: true },
      META,
    );
    const result = await h.services.sessions.verify(remote(), sessionId, META);
    expect(result.ended).toBe(false);
    expect(result.session.permissions).toEqual(['screen_view']);
    await h.services.permissions.removeDevicePermission(
      owner.id,
      kiosk.record.id,
      operator.id,
      META,
    );
    await h.services.sessions.end(remote(), sessionId, null, META);
  });

  it('fails the session when the controller loses access entirely', async () => {
    const sessionId = await connectedSession(['screen_view']);
    await h.db.query(
      `update public.organization_members set role = 'user' where organization_id = $1 and user_id = $2`,
      [orgId, operator.id],
    );
    const result = await h.services.sessions.verify(remote(), sessionId, META);
    expect(result.ended).toBe(true);
    expect(result.session).toMatchObject({ state: 'FAILED', failureReason: 'access_revoked' });
    await h.db.query(
      `update public.organization_members set role = 'operator' where organization_id = $1 and user_id = $2`,
      [orgId, operator.id],
    );
  });
});

describe('peer audit events', () => {
  it('records transfers only when the session grants the permission', async () => {
    const sessionId = await connectedSession(['screen_view', 'clipboard']);
    await h.services.sessions.recordPeerAudit(
      controller(),
      sessionId,
      { event: 'CLIPBOARD_TRANSFERRED', direction: 'controller_to_host', bytes: 12 },
      META,
    );
    expect(
      await errorCode(
        h.services.sessions.recordPeerAudit(
          controller(),
          sessionId,
          { event: 'FILE_TRANSFER_STARTED', direction: 'controller_to_host', bytes: 1 },
          META,
        ),
      ),
    ).toBe('forbidden');
    expect(
      await errorCode(
        h.services.sessions.recordPeerAudit(
          { userId: stranger.id, deviceId: null },
          sessionId,
          { event: 'CLIPBOARD_TRANSFERRED', direction: 'controller_to_host', bytes: 1 },
          META,
        ),
      ),
    ).toBe('not_found');
    const [row] = await h.db.query<{ metadata: Record<string, unknown> }>(
      `select metadata from public.audit_logs where action = 'CLIPBOARD_TRANSFERRED' and target_id = $1`,
      [sessionId],
    );
    expect(row?.metadata).toEqual({
      reportedBy: 'controller',
      direction: 'controller_to_host',
      bytes: 12,
      sha256: null,
    });
    await h.services.sessions.end(remote(), sessionId, null, META);
  });
});

describe('session expiry and disconnects', () => {
  it('expires approved sessions that never connect', async () => {
    await h.db.query(
      `update public.connection_requests set status = 'cancelled' where status = 'pending'`,
    );
    const created = await h.services.connections.create(
      controller(),
      { targetDeviceCode: kiosk.record.deviceCode, permissions: ['screen_view'] },
      META,
    );
    await h.services.connections.approve(remote(), created.request.id, undefined, META);
    expect(await h.services.sessions.expireStaleSessions(90)).toEqual([]);
    // Age the row the way time would (the updated_at trigger would otherwise reset it).
    await h.db.exec('alter table public.sessions disable trigger set_updated_at');
    await h.db.query(
      `update public.sessions set updated_at = now() - interval '5 minutes' where id = $1`,
      [created.session.id],
    );
    await h.db.exec('alter table public.sessions enable trigger set_updated_at');
    const expired = await h.services.sessions.expireStaleSessions(90);
    expect(expired).toEqual([
      expect.objectContaining({ sessionId: created.session.id, state: 'EXPIRED' }),
    ]);
    expect((await h.services.sessions.get(operator.id, created.session.id)).failureReason).toBe(
      'authorization_expired',
    );
  });

  it('finds and fails the live sessions of a disconnected device', async () => {
    const sessionId = await connectedSession(['screen_view']);
    const live = await h.services.sessions.liveSessionsForDevice(kiosk.record.id);
    expect(live.map((s) => s.id)).toContain(sessionId);
    const failed = await h.services.sessions.failSessions([sessionId], 'peer_disconnected');
    expect(failed[0]).toMatchObject({ state: 'FAILED', failureReason: 'peer_disconnected' });
    expect(await h.services.sessions.failSessions([sessionId], 'peer_disconnected')).toEqual([]);
    expect(
      (await h.services.sessions.liveSessionsForDevice(kiosk.record.id)).map((s) => s.id),
    ).not.toContain(sessionId);
  });

  it('keeps the sweeper away from client roles', async () => {
    await expect(
      asUser(h.db, owner.id, (tx) => tx.query('select * from public.expire_stale_sessions(90)')),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('buildIceServers', () => {
  it('derives expiring coturn REST credentials', () => {
    const secret = 'x'.repeat(40);
    const now = Date.parse('2026-10-05T00:00:00Z');
    const config = buildIceServers(
      {
        stunUrls: ['stun:turn.example:3478'],
        turnUrls: ['turn:turn.example:3478?transport=udp'],
        turnSecret: secret,
        ttlSeconds: 600,
      },
      'user-1',
      now,
    );
    const turn = config.iceServers[1];
    expect(config.iceServers[0]).toEqual({ urls: ['stun:turn.example:3478'] });
    expect(turn?.username).toBe(`${now / 1000 + 600}:user-1`);
    expect(turn?.credential).toBe(
      createHmac('sha1', secret)
        .update(turn?.username ?? '')
        .digest('base64'),
    );
    expect(config.expiresAt).toBe('2026-10-05T00:10:00.000Z');
  });

  it('omits TURN without a secret and STUN when unset', () => {
    expect(
      buildIceServers(
        { stunUrls: [], turnUrls: ['turn:x'], turnSecret: undefined, ttlSeconds: 60 },
        'u',
      ).iceServers,
    ).toEqual([]);
  });
});
