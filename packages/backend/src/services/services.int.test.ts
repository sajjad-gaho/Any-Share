import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asUser } from '../db/types';
import { AppError } from '../errors';
import { signTestToken } from '../testing/fake-auth';
import { createTestHarness, type TestDevice, type TestHarness, type TestUser } from '../testing';
import { NO_REQUEST_META } from './context';

const META = { ip: '203.0.113.9', userAgent: 'vitest' };

function code(error: unknown): string | undefined {
  return error instanceof AppError ? error.code : undefined;
}

async function expectCode(promise: Promise<unknown>, expected: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(code(error), String(error)).toBe(expected);
}

const auditActions = async (h: TestHarness) =>
  (
    await h.db.query<{ action: string }>(
      'select action::text from public.audit_logs order by created_at',
    )
  ).map((r) => r.action);

describe('authentication', () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await createTestHarness({ rateLimitMultiplier: 1 });
  });
  afterAll(() => h.close());

  it('registers, logs in, audits LOGIN and authenticates the token', async () => {
    const registered = await h.services.auth.register({
      email: 'Ada@Example.test',
      password: 'a long password',
      displayName: 'Ada',
    });
    expect(registered.user.email).toBe('ada@example.test');

    const result = await h.services.auth.login(
      { email: 'ada@example.test', password: 'a long password' },
      META,
    );
    const context = await h.services.auth.authenticate(result.tokens?.accessToken ?? '');
    expect(context.userId).toBe(result.user.id);
    expect(await auditActions(h)).toContain('LOGIN');

    const [entry] = await h.db.query<{ metadata: Record<string, unknown>; ip: string }>(
      `select metadata, host(ip_address) as ip from public.audit_logs where action = 'LOGIN'`,
    );
    expect(entry?.ip).toBe('203.0.113.9');
    expect(JSON.stringify(entry)).not.toContain('a long password');
  });

  it('rejects tampered, foreign and expired tokens', async () => {
    const user = await h.createUser('Eve');
    const [, payload, signature] = user.accessToken.split('.');
    const forged = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${payload}.`;
    await expectCode(h.services.auth.authenticate(forged), 'unauthenticated');
    await expectCode(
      h.services.auth.authenticate(
        `${user.accessToken.split('.')[0]}.${payload}.${signature?.slice(1)}x`,
      ),
      'unauthenticated',
    );
    const otherSecret = await signTestToken({ sub: user.id }, undefined, {
      secret: 'another-secret-that-is-also-quite-long-000',
    });
    await expectCode(h.services.auth.authenticate(otherSecret), 'unauthenticated');
    const wrongAudience = await signTestToken({ sub: user.id }, undefined, { audience: 'anon' });
    await expectCode(h.services.auth.authenticate(wrongAudience), 'unauthenticated');
    const expired = await signTestToken({ sub: user.id }, Math.floor(Date.now() / 1000) - 60);
    await expectCode(h.services.auth.authenticate(expired), 'unauthenticated');
  });

  it('logout revokes the session immediately and audits LOGOUT', async () => {
    const user = await h.createUser('Logout');
    const context = await h.services.auth.authenticate(user.accessToken);
    await h.services.auth.logout(context, META);
    await expectCode(h.services.auth.authenticate(user.accessToken), 'unauthenticated');
    await expectCode(h.services.auth.refresh(user.refreshToken), 'unauthenticated');
    expect(await auditActions(h)).toContain('LOGOUT');
  });

  it('restores a session with the refresh token (rotating it)', async () => {
    const user = await h.createUser('Refresh');
    const refreshed = await h.services.auth.refresh(user.refreshToken);
    expect(refreshed.user.id).toBe(user.id);
    await h.services.auth.authenticate(refreshed.tokens?.accessToken ?? '');
    await expectCode(h.services.auth.refresh(user.refreshToken), 'unauthenticated');
  });

  it('locks an account after repeated wrong passwords', async () => {
    const user = await h.createUser('Brute');
    for (let i = 0; i < 5; i++) {
      await expectCode(
        h.services.auth.login({ email: user.email, password: 'wrong' }, { ip: `198.51.100.${i}` }),
        'unauthenticated',
      );
    }
    // Locked even with the right password, from a fresh IP.
    await expectCode(
      h.services.auth.login(
        { email: user.email, password: user.password },
        { ip: '198.51.100.99' },
      ),
      'rate_limited',
    );
  });

  it('resets a password with the emailed code and signs out every session', async () => {
    const user = await h.createUser('Reset');
    await h.services.auth.requestPasswordReset('unknown@example.test'); // no enumeration, no throw
    await h.services.auth.requestPasswordReset(user.email);
    const resetCode = h.authProvider.resetCodeFor(user.email) ?? '';
    await expectCode(
      h.services.auth.confirmPasswordReset(
        { email: user.email, code: '000000', newPassword: 'a brand new password' },
        META,
      ),
      'unauthenticated',
    );
    await h.services.auth.confirmPasswordReset(
      { email: user.email, code: resetCode, newPassword: 'a brand new password' },
      META,
    );
    await expectCode(h.services.auth.authenticate(user.accessToken), 'unauthenticated');
    await h.services.auth.login({ email: user.email, password: 'a brand new password' }, META);
  });
});

describe('organizations and RBAC', () => {
  let h: TestHarness;
  let owner: TestUser;
  let admin: TestUser;
  let operator: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let orgId: string;

  beforeAll(async () => {
    h = await createTestHarness();
    [owner, admin, operator, member, outsider] = (await Promise.all(
      ['Owner', 'Admin', 'Operator', 'Member', 'Outsider'].map((n) => h.createUser(n)),
    )) as [TestUser, TestUser, TestUser, TestUser, TestUser];
    orgId = await h.createOrganization(owner, 'acme');
    await h.services.organizations.addMember(owner.id, orgId, {
      email: admin.email,
      role: 'admin',
    });
    await h.services.organizations.addMember(admin.id, orgId, {
      email: operator.email,
      role: 'operator',
    });
    await h.services.organizations.addMember(admin.id, orgId, {
      email: member.email,
      role: 'user',
    });
  });
  afterAll(() => h.close());

  it('reads roles from the database, scoped to the caller', async () => {
    expect((await h.services.organizations.listForUser(operator.id)).map((o) => o.role)).toEqual([
      'operator',
    ]);
    const me = await h.services.users.getMe(member.id, member.email);
    expect(me.memberships).toEqual([
      expect.objectContaining({ organizationId: orgId, role: 'user' }),
    ]);
    await expectCode(h.services.organizations.get(outsider.id, orgId), 'not_found');
    await expectCode(h.services.organizations.listMembers(outsider.id, orgId), 'not_found');
  });

  it('lets admins manage operators and users but not admins or owners', async () => {
    await expectCode(
      h.services.organizations.addMember(admin.id, orgId, { email: outsider.email, role: 'admin' }),
      'forbidden',
    );
    await expectCode(
      h.services.organizations.updateMemberRole(admin.id, orgId, owner.id, 'user'),
      'forbidden',
    );
    const promoted = await h.services.organizations.updateMemberRole(
      admin.id,
      orgId,
      member.id,
      'operator',
    );
    expect(promoted.role).toBe('operator');
    await h.services.organizations.updateMemberRole(admin.id, orgId, member.id, 'user');
  });

  it('gives operators and users no member management', async () => {
    await expectCode(
      h.services.organizations.addMember(operator.id, orgId, {
        email: outsider.email,
        role: 'user',
      }),
      'forbidden',
    );
    await expectCode(
      h.services.organizations.removeMember(member.id, orgId, operator.id),
      'forbidden',
    );
  });

  it('protects the last owner', async () => {
    await expectCode(
      h.services.organizations.updateMemberRole(owner.id, orgId, owner.id, 'admin'),
      'conflict',
    );
    await expectCode(h.services.organizations.removeMember(owner.id, orgId, owner.id), 'conflict');
  });

  it('rejects duplicate slugs', async () => {
    await expectCode(
      h.services.organizations.create(outsider.id, { name: 'Copy', slug: 'acme' }),
      'conflict',
    );
  });

  it('only lets owners and admins register devices into the organisation', async () => {
    await expectCode(h.registerDevice(operator, { organizationId: orgId }), 'forbidden');
    await expectCode(h.registerDevice(outsider, { organizationId: orgId }), 'not_found');
    const device = await h.registerDevice(admin, { organizationId: orgId });
    expect(device.record.organizationId).toBe(orgId);
  });
});

describe('devices', () => {
  let h: TestHarness;
  let alice: TestUser;
  let bob: TestUser;
  let pc: TestDevice;

  beforeAll(async () => {
    h = await createTestHarness();
    alice = await h.createUser('Alice');
    bob = await h.createUser('Bob');
    pc = await h.registerDevice(alice, { name: 'Alice PC' });
  });
  afterAll(() => h.close());

  it('registers with a server-generated public ID and key fingerprint', async () => {
    expect(pc.record.deviceCode).toMatch(/^\d{9}$/);
    expect(pc.record.ownerId).toBe(alice.id);
    expect(pc.record.keyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(pc.record.status).toBe('offline');
    expect(await auditActions(h)).toContain('DEVICE_REGISTERED');
  });

  it('refuses to register the same key twice or a non-Ed25519 key', async () => {
    await expectCode(
      h.services.devices.register(
        bob.id,
        { name: 'Copy', os: { family: 'windows', version: '11' }, publicKey: pc.publicKey },
        NO_REQUEST_META,
      ),
      'conflict',
    );
    await expectCode(
      h.services.devices.register(
        bob.id,
        {
          name: 'Bad',
          os: { family: 'windows', version: '11' },
          publicKey: Buffer.alloc(44).toString('base64'),
        },
        NO_REQUEST_META,
      ),
      'bad_request',
    );
  });

  it("hides and protects another user's device", async () => {
    expect(await h.services.devices.list(bob.id)).toEqual([]);
    await expectCode(h.services.devices.get(bob.id, pc.record.id), 'not_found');
    await expectCode(
      h.services.devices.update(bob.id, pc.record.id, { name: 'pwned' }, NO_REQUEST_META),
      'not_found',
    );
    await expectCode(h.services.devices.revoke(bob.id, pc.record.id, NO_REQUEST_META), 'not_found');
  });

  it('updates fields and access password (hashed)', async () => {
    const updated = await h.services.devices.update(
      alice.id,
      pc.record.id,
      { name: 'Renamed', requireApproval: false, accessPassword: 'unattended pw' },
      META,
    );
    expect(updated).toMatchObject({
      name: 'Renamed',
      requireApproval: false,
      hasAccessPassword: true,
    });
    const cleared = await h.services.devices.update(
      alice.id,
      pc.record.id,
      { accessPassword: null },
      META,
    );
    expect(cleared.hasAccessPassword).toBe(false);
    expect(await auditActions(h)).toContain('PERMISSION_CHANGED');
  });

  it('reports presence from is_online plus a fresh last_seen_at', async () => {
    await h.services.devices.setOnline(pc.record.id, true);
    expect((await h.services.devices.get(alice.id, pc.record.id)).status).toBe('online');
    await h.db.query(
      `update public.devices set last_seen_at = now() - interval '1 hour' where id = $1`,
      [pc.record.id],
    );
    expect((await h.services.devices.get(alice.id, pc.record.id)).status).toBe('offline');
    await h.services.devices.touchLastSeen([pc.record.id]);
    expect((await h.services.devices.get(alice.id, pc.record.id)).status).toBe('online');
    await h.services.devices.setOnline(pc.record.id, false);
  });

  it('revokes: credentials invalidated, device hidden, audited', async () => {
    const other = await h.registerDevice(alice, { name: 'Old laptop' });
    await h.services.devices.revoke(alice.id, other.record.id, META);
    expect((await h.services.devices.list(alice.id)).map((d) => d.id)).not.toContain(
      other.record.id,
    );
    expect(await h.services.devices.getPublicKey(other.record.id)).toBeNull();
    expect(await auditActions(h)).toContain('DEVICE_REVOKED');
    await expectCode(h.services.devices.revoke(alice.id, other.record.id, META), 'not_found');
  });
});

describe('connection requests and sessions', () => {
  let h: TestHarness;
  let owner: TestUser;
  let operator: TestUser;
  let member: TestUser;
  let stranger: TestUser;
  let orgId: string;
  let target: TestDevice;
  let operatorPc: TestDevice;
  let ownerLaptop: TestDevice;

  beforeAll(async () => {
    h = await createTestHarness({ settings: { connectionRequestTtlSeconds: 60 } });
    owner = await h.createUser('Owner');
    operator = await h.createUser('Operator');
    member = await h.createUser('Member');
    stranger = await h.createUser('Stranger');
    orgId = await h.createOrganization(owner);
    await h.addMember(orgId, operator, 'operator');
    await h.addMember(orgId, member, 'user');
    target = await h.registerDevice(owner, { name: 'Kiosk', organizationId: orgId });
    operatorPc = await h.registerDevice(operator, { name: 'Operator PC' });
    ownerLaptop = await h.registerDevice(owner, { name: 'Owner laptop' });
  });
  afterAll(() => h.close());

  // Each test starts with no pending requests to the target.
  beforeEach(async () => {
    await h.db.query(
      `update public.connection_requests set status = 'cancelled' where status = 'pending'`,
    );
  });

  const operatorActor = () => ({ userId: operator.id, deviceId: operatorPc.record.id });
  const remoteActor = () => ({ userId: owner.id, deviceId: target.record.id });
  const request = (
    permissions: (
      | 'screen_view'
      | 'mouse'
      | 'keyboard'
      | 'clipboard'
      | 'file_transfer'
      | 'audio'
      | 'remote_control'
    )[] = ['screen_view'],
  ) =>
    h.services.connections.create(
      operatorActor(),
      { targetDeviceCode: target.record.deviceCode, permissions },
      META,
    );

  it('walks the full approval flow through the state machine', async () => {
    const created = await request(['screen_view', 'mouse', 'remote_control']);
    expect(created.autoApproved).toBe(false);
    expect(created.session.state).toBe('APPROVAL_PENDING');
    expect(created.request.status).toBe('pending');

    const approved = await h.services.connections.approve(
      remoteActor(),
      created.request.id,
      undefined,
      META,
    );
    expect(approved.request.status).toBe('approved');
    expect(approved.session.state).toBe('SIGNALING');
    expect(approved.session.permissions).toEqual(['screen_view', 'mouse', 'remote_control']);

    const relay = await h.services.sessions.authorizeRelay(
      operatorActor(),
      created.session.id,
      'offer',
    );
    expect(relay).toMatchObject({ side: 'controller', session: { state: 'CONNECTING' } });
    await h.services.sessions.authorizeRelay(remoteActor(), created.session.id, 'answer');
    await expectCode(
      h.services.sessions.authorizeRelay(remoteActor(), created.session.id, 'offer'),
      'forbidden',
    );

    const connected = await h.services.sessions.reportState(
      operatorActor(),
      created.session.id,
      { state: 'CONNECTED' },
      META,
    );
    expect(connected.state).toBe('CONNECTED');
    expect(connected.connectedAt).not.toBeNull();

    const ended = await h.services.sessions.end(remoteActor(), created.session.id, 'done', META);
    expect(ended.session.state).toBe('ENDED');
    expect(ended.endedBy).toBe('target');
    await expectCode(
      h.services.sessions.end(operatorActor(), created.session.id, null, META),
      'invalid_state',
    );

    const actions = await auditActions(h);
    for (const action of [
      'CONNECTION_REQUESTED',
      'CONNECTION_APPROVED',
      'SESSION_STARTED',
      'SESSION_ENDED',
    ]) {
      expect(actions).toContain(action);
    }
  });

  it('lets the remote approve fewer permissions, never more', async () => {
    const created = await request(['screen_view', 'clipboard']);
    await expectCode(
      h.services.connections.approve(
        remoteActor(),
        created.request.id,
        ['screen_view', 'audio'],
        META,
      ),
      'bad_request',
    );
    const approved = await h.services.connections.approve(
      remoteActor(),
      created.request.id,
      ['screen_view'],
      META,
    );
    expect(approved.session.permissions).toEqual(['screen_view']);
  });

  it('rejects: session FAILED with reason, audited', async () => {
    const created = await request();
    const rejected = await h.services.connections.reject(
      remoteActor(),
      created.request.id,
      'busy',
      META,
    );
    expect(rejected.request.status).toBe('rejected');
    expect(rejected.session).toMatchObject({ state: 'FAILED', failureReason: 'rejected' });
    expect(await auditActions(h)).toContain('CONNECTION_REJECTED');
    await expectCode(
      h.services.connections.approve(remoteActor(), created.request.id, undefined, META),
      'invalid_state',
    );
  });

  it('only the target device, operated by someone who manages it, may respond', async () => {
    const created = await request();
    // The controller cannot approve their own request.
    await expectCode(
      h.services.connections.approve(operatorActor(), created.request.id, undefined, META),
      'not_found',
    );
    // The right user, but from another device.
    await expectCode(
      h.services.connections.approve(
        { userId: owner.id, deviceId: ownerLaptop.record.id },
        created.request.id,
        undefined,
        META,
      ),
      'not_found',
    );
    // The right device id claimed by a user who does not manage it.
    await expectCode(
      h.services.connections.reject(
        { userId: stranger.id, deviceId: target.record.id },
        created.request.id,
        null,
        META,
      ),
      'not_found',
    );
  });

  it('enforces permissions server-side against the role ceiling', async () => {
    // Operators may not transfer files or listen to audio on org devices.
    await expectCode(request(['screen_view', 'file_transfer']), 'forbidden');
    // Plain users have no access without an explicit grant; the device "does not exist".
    await expectCode(
      h.services.connections.create(
        { userId: member.id, deviceId: null },
        { targetDeviceCode: target.record.deviceCode, permissions: ['screen_view'] },
        META,
      ),
      'not_found',
    );
    // Strangers cannot reach the device either, and unknown codes look identical.
    await expectCode(
      h.services.connections.create(
        { userId: stranger.id, deviceId: null },
        { targetDeviceCode: target.record.deviceCode, permissions: ['screen_view'] },
        META,
      ),
      'not_found',
    );
    await expectCode(
      h.services.connections.create(
        { userId: stranger.id, deviceId: null },
        { targetDeviceCode: '123456782', permissions: ['screen_view'] },
        META,
      ),
      'not_found',
    );
    // Inconsistent sets are refused even if the transport skipped validation.
    await expectCode(request(['screen_view', 'mouse']), 'bad_request');
  });

  it('honours an explicit grant, including auto-approval', async () => {
    await h.services.permissions.setDevicePermission(
      owner.id,
      target.record.id,
      { userId: member.id, permissions: ['screen_view', 'audio'], requireApproval: false },
      META,
    );
    const created = await h.services.connections.create(
      { userId: member.id, deviceId: null },
      { targetDeviceCode: target.record.deviceCode, permissions: ['screen_view', 'audio'] },
      META,
    );
    expect(created.autoApproved).toBe(true);
    expect(created.session.state).toBe('SIGNALING');
    expect(created.session.permissions).toEqual(['screen_view', 'audio']);
    await h.services.permissions.removeDevicePermission(
      owner.id,
      target.record.id,
      member.id,
      META,
    );
  });

  it('auto-approves the device owner connecting from their own other device', async () => {
    const created = await h.services.connections.create(
      { userId: owner.id, deviceId: ownerLaptop.record.id },
      { targetDeviceCode: target.record.deviceCode, permissions: ['screen_view', 'file_transfer'] },
      META,
    );
    expect(created.autoApproved).toBe(true);
    await expectCode(
      h.services.connections.create(
        { userId: owner.id, deviceId: target.record.id },
        { targetDeviceCode: target.record.deviceCode, permissions: ['screen_view'] },
        META,
      ),
      'bad_request',
    );
  });

  it('requires the access password when one is set, with lockout', async () => {
    await h.services.devices.update(
      owner.id,
      target.record.id,
      { accessPassword: 'kiosk-secret' },
      META,
    );
    await expectCode(request(), 'forbidden');
    const ok = await h.services.connections.create(
      operatorActor(),
      {
        targetDeviceCode: target.record.deviceCode,
        permissions: ['screen_view'],
        accessPassword: 'kiosk-secret',
      },
      META,
    );
    expect(ok.request.status).toBe('pending');
    await h.services.connections.cancel(operator.id, ok.request.id);
    for (let i = 0; i < 5; i++) {
      await expectCode(
        h.services.connections.create(
          operatorActor(),
          {
            targetDeviceCode: target.record.deviceCode,
            permissions: ['screen_view'],
            accessPassword: `wrong ${i}`,
          },
          META,
        ),
        'forbidden',
      );
    }
    await expectCode(
      h.services.connections.create(
        operatorActor(),
        {
          targetDeviceCode: target.record.deviceCode,
          permissions: ['screen_view'],
          accessPassword: 'kiosk-secret',
        },
        META,
      ),
      'rate_limited',
    );
    h.limiters.accessPasswordGuard.recordSuccess(`device:${target.record.id}:user:${operator.id}`);
    await h.services.devices.update(owner.id, target.record.id, { accessPassword: null }, META);
  });

  it('allows only one pending request per controller and device', async () => {
    await request();
    await expectCode(request(), 'conflict');
  });

  it('lets the controller cancel, and only the controller', async () => {
    const created = await request();
    await expectCode(h.services.connections.cancel(owner.id, created.request.id), 'not_found');
    const cancelled = await h.services.connections.cancel(operator.id, created.request.id);
    expect(cancelled.status).toBe('cancelled');
    expect((await h.services.sessions.get(operator.id, created.session.id)).state).toBe('ENDED');
  });

  it('expires stale requests and their sessions', async () => {
    const created = await request();
    // expires_at is immutable through the trigger; age the row the way time would.
    await h.db.exec(
      `alter table public.connection_requests disable trigger enforce_connection_request_transition`,
    );
    await h.db.query(
      `update public.connection_requests set created_at = now() - interval '2 minutes',
              expires_at = now() - interval '1 second' where id = $1`,
      [created.request.id],
    );
    await h.db.exec(
      `alter table public.connection_requests enable trigger enforce_connection_request_transition`,
    );

    await expectCode(
      h.services.connections.approve(remoteActor(), created.request.id, undefined, META),
      'expired',
    );
    const expired = await h.services.connections.expireStale();
    expect(expired).toEqual([
      expect.objectContaining({ requestId: created.request.id, sessionId: created.session.id }),
    ]);
    expect((await h.services.connections.get(operator.id, created.request.id)).status).toBe(
      'expired',
    );
    expect((await h.services.sessions.get(operator.id, created.session.id)).state).toBe('EXPIRED');
    expect(await h.services.connections.expireStale()).toEqual([]);
  });

  it('expires requests in real time with a short TTL', async () => {
    const quick = await createTestHarness({ settings: { connectionRequestTtlSeconds: 1 } });
    try {
      const o = await quick.createUser('O');
      const c = await quick.createUser('C');
      const org = await quick.createOrganization(o);
      await quick.addMember(org, c, 'operator');
      const d = await quick.registerDevice(o, { organizationId: org });
      const created = await quick.services.connections.create(
        { userId: c.id, deviceId: null },
        { targetDeviceCode: d.record.deviceCode, permissions: ['screen_view'] },
        NO_REQUEST_META,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      expect((await quick.services.connections.expireStale()).map((e) => e.requestId)).toEqual([
        created.request.id,
      ]);
    } finally {
      await quick.close();
    }
  });

  it('lets only the remote change session permissions, capped by the ceiling', async () => {
    const created = await request(['screen_view', 'mouse', 'keyboard', 'remote_control']);
    await h.services.connections.approve(remoteActor(), created.request.id, undefined, META);

    const narrowed = await h.services.sessions.updatePermissions(
      remoteActor(),
      created.session.id,
      ['screen_view', 'keyboard', 'remote_control'],
      META,
    );
    expect(narrowed.permissions).toEqual(['screen_view', 'keyboard', 'remote_control']);

    // Asking for more than an operator's ceiling silently caps it (no file transfer / audio).
    const capped = await h.services.sessions.updatePermissions(
      remoteActor(),
      created.session.id,
      ['screen_view', 'file_transfer', 'audio', 'clipboard'],
      META,
    );
    expect(capped.permissions).toEqual(['screen_view', 'clipboard']);

    // Dropping remote_control drops dependent input permissions.
    const noControl = await h.services.sessions.updatePermissions(
      remoteActor(),
      created.session.id,
      ['screen_view', 'mouse'],
      META,
    );
    expect(noControl.permissions).toEqual(['screen_view']);

    await expectCode(
      h.services.sessions.updatePermissions(
        operatorActor(),
        created.session.id,
        ['screen_view'],
        META,
      ),
      'forbidden',
    );
    await expectCode(
      h.services.sessions.updatePermissions(
        { userId: stranger.id, deviceId: null },
        created.session.id,
        ['screen_view'],
        META,
      ),
      'not_found',
    );
  });

  it('rejects invalid state reports and relays outside signaling', async () => {
    const created = await request();
    await expectCode(
      h.services.sessions.reportState(
        operatorActor(),
        created.session.id,
        { state: 'CONNECTED' },
        META,
      ),
      'invalid_state',
    );
    await expectCode(
      h.services.sessions.authorizeRelay(operatorActor(), created.session.id, 'offer'),
      'invalid_state',
    );
  });

  it('fails live sessions when the target device is revoked', async () => {
    const extra = await h.registerDevice(owner, { name: 'Temp', organizationId: orgId });
    const created = await h.services.connections.create(
      operatorActor(),
      { targetDeviceCode: extra.record.deviceCode, permissions: ['screen_view'] },
      META,
    );
    await h.services.connections.approve(
      { userId: owner.id, deviceId: extra.record.id },
      created.request.id,
      undefined,
      META,
    );
    const { sessionIds } = await h.services.devices.revoke(owner.id, extra.record.id, META);
    expect(sessionIds).toEqual([created.session.id]);
    const session = await h.services.sessions.get(operator.id, created.session.id);
    expect(session).toMatchObject({ state: 'FAILED', failureReason: 'device_revoked' });
  });

  it('lists requests by direction under RLS', async () => {
    const created = await request();
    const outgoing = await h.services.connections.list(operator.id, {
      direction: 'outgoing',
      status: 'pending',
      limit: 10,
    });
    expect(outgoing.map((r) => r.id)).toEqual([created.request.id]);
    const incoming = await h.services.connections.list(owner.id, {
      direction: 'incoming',
      status: 'pending',
      limit: 10,
    });
    expect(incoming.map((r) => r.id)).toContain(created.request.id);
    expect(
      await h.services.connections.list(stranger.id, { direction: 'incoming', limit: 10 }),
    ).toEqual([]);
  });

  it('rate-limits connection requests per user', async () => {
    const strict = await createTestHarness({ rateLimitMultiplier: 1 });
    try {
      const o = await strict.createUser('O');
      const d = await strict.registerDevice(o);
      const laptop = await strict.registerDevice(o);
      let limited = false;
      for (let i = 0; i < 12 && !limited; i++) {
        try {
          const created = await strict.services.connections.create(
            { userId: o.id, deviceId: laptop.record.id },
            { targetDeviceCode: d.record.deviceCode, permissions: ['screen_view'] },
            NO_REQUEST_META,
          );
          await strict.services.sessions.end(
            { userId: o.id, deviceId: laptop.record.id },
            created.session.id,
            null,
            NO_REQUEST_META,
          );
        } catch (error) {
          limited = code(error) === 'rate_limited';
          if (!limited) throw error;
        }
      }
      expect(limited).toBe(true);
    } finally {
      await strict.close();
    }
  });

  it('never stores tokens, passwords or SDP in the audit log', async () => {
    const rows = await h.db.query<{ metadata: unknown }>('select metadata from public.audit_logs');
    const all = JSON.stringify(rows);
    expect(all).not.toMatch(/kiosk-secret|accessToken|password"|v=0/);
  });

  it('reads sessions under RLS', async () => {
    const visible = await asUser(h.db, stranger.id, (tx) =>
      tx.query('select id from public.sessions'),
    );
    expect(visible).toEqual([]);
    expect((await h.services.sessions.list(operator.id, { limit: 100 })).length).toBeGreaterThan(0);
  });
});
