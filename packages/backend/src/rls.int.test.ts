/**
 * Row level security, grants and integrity triggers, exercised directly in SQL
 * against the real migrations. Every "as user" query runs as the `authenticated`
 * role with `auth.uid()` set, exactly like Supabase's Data API — i.e. what a
 * client holding the public anon key and a user JWT could do.
 */
import { SESSION_STATES, canTransition } from '@remote-desktop/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser } from './db/types';
import { NO_REQUEST_META } from './services/context';
import { createTestHarness, type TestDevice, type TestHarness, type TestUser } from './testing';

let h: TestHarness;
let alice: TestUser; // org owner, owns orgDevice and alicePc
let bob: TestUser; // unrelated user with a personal device
let carol: TestUser; // operator
let dave: TestUser; // plain user
let orgId: string;
let alicePc: TestDevice;
let bobPc: TestDevice;
let orgDevice: TestDevice;

const as = <T = Record<string, unknown>>(user: TestUser, sql: string, params: unknown[] = []) =>
  asUser(h.db, user.id, (tx) => tx.query<T>(sql, params));

const asAnon = (sql: string) =>
  h.db.transaction(async (tx) => {
    await tx.query('set local role anon');
    return tx.query(sql);
  });

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

beforeAll(async () => {
  h = await createTestHarness();
  alice = await h.createUser('Alice');
  bob = await h.createUser('Bob');
  carol = await h.createUser('Carol');
  dave = await h.createUser('Dave');
  orgId = await h.createOrganization(alice);
  await h.addMember(orgId, carol, 'operator');
  await h.addMember(orgId, dave, 'user');
  alicePc = await h.registerDevice(alice, { name: 'Alice PC' });
  bobPc = await h.registerDevice(bob, { name: 'Bob PC' });
  orgDevice = await h.registerDevice(alice, { name: 'Front desk', organizationId: orgId });
});

afterAll(async () => {
  await h.close();
});

describe('profiles', () => {
  it('are created by the auth trigger', async () => {
    const [row] = await h.db.query<{ display_name: string }>(
      'select display_name from public.profiles where id = $1',
      [alice.id],
    );
    expect(row?.display_name).toBe('Alice');
  });

  it('are visible to yourself and organisation co-members only', async () => {
    expect(ids(await as(bob, 'select id from public.profiles'))).toEqual([bob.id]);
    expect(ids(await as(carol, 'select id from public.profiles'))).toEqual(
      [alice.id, carol.id, dave.id].sort(),
    );
  });

  it('can only be updated by their owner, and only display fields', async () => {
    await as(bob, `update public.profiles set display_name = 'Mallory' where id = $1`, [alice.id]);
    const [row] = await h.db.query<{ display_name: string }>(
      'select display_name from public.profiles where id = $1',
      [alice.id],
    );
    expect(row?.display_name).toBe('Alice');
    await expect(
      as(bob, 'update public.profiles set created_at = now() where id = $1', [bob.id]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('devices', () => {
  it("never exposes another user's personal device", async () => {
    expect(ids(await as(bob, 'select id from public.devices'))).toEqual([bobPc.record.id]);
    expect(ids(await as(alice, 'select id from public.devices'))).toEqual(
      [alicePc.record.id, orgDevice.record.id].sort(),
    );
    expect(
      await as(bob, 'select id from public.devices where id = $1', [alicePc.record.id]),
    ).toEqual([]);
  });

  it('shows organisation devices to operators but not to plain users without a grant', async () => {
    expect(ids(await as(carol, 'select id from public.devices'))).toEqual([orgDevice.record.id]);
    expect(await as(dave, 'select id from public.devices')).toEqual([]);
  });

  it('shows a device to a plain user once explicitly granted', async () => {
    await h.services.permissions.setDevicePermission(
      alice.id,
      orgDevice.record.id,
      { userId: dave.id, permissions: ['screen_view'], requireApproval: true },
      NO_REQUEST_META,
    );
    expect(ids(await as(dave, 'select id from public.devices'))).toEqual([orgDevice.record.id]);
    expect((await as(dave, 'select user_id from public.device_permissions')).length).toBe(1);
    expect(await as(carol, 'select user_id from public.device_permissions')).toEqual([]);
  });

  it('cannot be written by clients at all', async () => {
    await expect(
      as(bob, `update public.devices set owner_id = $1 where id = $2`, [bob.id, alicePc.record.id]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(
        bob,
        `insert into public.devices (device_code, owner_id, name, os_family, os_version, key_fingerprint)
         values ('123456782', $1, 'x', 'windows', '11', repeat('a', 64))`,
        [bob.id],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(as(alice, 'delete from public.devices')).rejects.toThrow(/permission denied/);
  });
});

describe('device_credentials', () => {
  it('are unreadable by every client role, including the owner', async () => {
    await expect(as(alice, 'select * from public.device_credentials')).rejects.toThrow(
      /permission denied/,
    );
    await expect(asAnon('select * from public.device_credentials')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('store public keys and Argon2id hashes, never plaintext', async () => {
    await h.services.devices.update(
      alice.id,
      alicePc.record.id,
      { accessPassword: 'unattended-secret' },
      NO_REQUEST_META,
    );
    const rows = await h.db.query<{
      kind: string;
      public_key: string | null;
      secret_hash: string | null;
    }>(
      `select kind::text as kind, public_key, secret_hash from public.device_credentials
        where device_id = $1 and revoked_at is null order by device_credentials.kind`,
      [alicePc.record.id],
    );
    expect(rows.map((r) => r.kind)).toEqual(['ed25519_public_key', 'access_password']);
    expect(rows[1]?.secret_hash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(rows)).not.toContain('unattended-secret');
    await expect(
      h.db.query(
        `insert into public.device_credentials (device_id, kind, secret_hash)
         values ($1, 'access_password', 'plaintext')`,
        [bobPc.record.id],
      ),
    ).rejects.toThrow(/device_credentials_shape/);
  });

  it('lets a viewer learn only whether a password exists', async () => {
    const [own] = await as<{ has: boolean }>(
      alice,
      'select private.device_has_access_password($1) as has',
      [alicePc.record.id],
    );
    expect(own?.has).toBe(true);
    const [foreign] = await as<{ has: boolean }>(
      bob,
      'select private.device_has_access_password($1) as has',
      [alicePc.record.id],
    );
    expect(foreign?.has).toBe(false);
  });
});

describe('organizations', () => {
  it('are visible to members only', async () => {
    expect(ids(await as(carol, 'select id from public.organizations'))).toEqual([orgId]);
    expect(await as(bob, 'select id from public.organizations')).toEqual([]);
    expect(await as(bob, 'select * from public.organization_members')).toEqual([]);
    expect((await as(dave, 'select * from public.organization_members')).length).toBe(3);
  });

  it('cannot have their membership changed by clients', async () => {
    await expect(
      as(
        bob,
        `insert into public.organization_members (organization_id, user_id, role)
         values ($1, $2, 'owner')`,
        [orgId, bob.id],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(carol, `update public.organization_members set role = 'owner' where user_id = $1`, [
        carol.id,
      ]),
    ).rejects.toThrow(/permission denied/);
  });

  it('always keep at least one owner', async () => {
    await expect(
      h.db.query(
        `update public.organization_members set role = 'admin'
          where organization_id = $1 and user_id = $2`,
        [orgId, alice.id],
      ),
    ).rejects.toThrow(/at least one owner/);
  });
});

describe('anon role', () => {
  it('sees nothing', async () => {
    for (const table of ['profiles', 'organizations', 'devices', 'sessions', 'audit_logs']) {
      await expect(asAnon(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
    }
  });

  it('cannot call privileged functions', async () => {
    await expect(asAnon('select * from public.expire_connection_requests()')).rejects.toThrow(
      /permission denied/,
    );
    await expect(as(bob, 'select * from public.expire_connection_requests()')).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('sessions and connection requests', () => {
  let requestId: string;
  let sessionId: string;

  beforeAll(async () => {
    const created = await h.services.connections.create(
      { userId: carol.id, deviceId: null },
      { targetDeviceCode: orgDevice.record.deviceCode, permissions: ['screen_view'] },
      NO_REQUEST_META,
    );
    requestId = created.request.id;
    sessionId = created.session.id;
  });

  it('are visible to the controller and the device managers only', async () => {
    expect(ids(await as(carol, 'select id from public.connection_requests'))).toEqual([requestId]);
    expect(ids(await as(alice, 'select id from public.connection_requests'))).toEqual([requestId]);
    expect(await as(bob, 'select id from public.connection_requests')).toEqual([]);
    expect(await as(dave, 'select id from public.connection_requests')).toEqual([]);
    expect(ids(await as(alice, 'select id from public.sessions'))).toEqual([sessionId]);
    expect(await as(bob, 'select id from public.sessions')).toEqual([]);
  });

  it('cannot be modified by clients', async () => {
    await expect(
      as(carol, `update public.connection_requests set status = 'approved' where id = $1`, [
        requestId,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(carol, `update public.sessions set state = 'CONNECTED' where id = $1`, [sessionId]),
    ).rejects.toThrow(/permission denied/);
  });

  it('enforce the session state machine in the database', async () => {
    await expect(
      h.db.query(`update public.sessions set state = 'CONNECTED' where id = $1`, [sessionId]),
    ).rejects.toThrow(/Invalid session transition APPROVAL_PENDING -> CONNECTED/);
    await expect(
      h.db.query(
        `insert into public.sessions (controller_user_id, target_device_id, state)
         values ($1, $2, 'CONNECTED')`,
        [carol.id, orgDevice.record.id],
      ),
    ).rejects.toThrow(/must start/);
    await expect(
      h.db.query('update public.sessions set controller_user_id = $1 where id = $2', [
        bob.id,
        sessionId,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('keep connection requests single-shot and time-bound', async () => {
    await h.db.query(`update public.connection_requests set status = 'rejected' where id = $1`, [
      requestId,
    ]);
    await expect(
      h.db.query(`update public.connection_requests set status = 'approved' where id = $1`, [
        requestId,
      ]),
    ).rejects.toThrow(/already rejected/);
    await expect(
      h.db.query(
        `insert into public.connection_requests
           (controller_user_id, target_device_id, requested_permissions, expires_at)
         values ($1, $2, '{screen_view}', now() + interval '1 hour')`,
        [carol.id, orgDevice.record.id],
      ),
    ).rejects.toThrow(/at most 10 minutes/);
    await expect(
      h.db.query(
        `insert into public.connection_requests
           (controller_user_id, target_device_id, requested_permissions, expires_at)
         values ($1, $2, '{mouse}', now() + interval '1 minute')`,
        [carol.id, orgDevice.record.id],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('session transition table', () => {
  it('matches packages/shared exactly for every pair of states', async () => {
    const rows = await h.db.query<{ f: string; t: string; ok: boolean }>(
      `select f::text as f, t::text as t, public.session_transition_allowed(f, t) as ok
         from unnest(enum_range(null::public.session_state)) f,
              unnest(enum_range(null::public.session_state)) t`,
    );
    expect(rows).toHaveLength(SESSION_STATES.length ** 2);
    for (const row of rows) {
      expect(row.ok, `${row.f} -> ${row.t}`).toBe(
        canTransition(
          row.f as (typeof SESSION_STATES)[number],
          row.t as (typeof SESSION_STATES)[number],
        ),
      );
    }
  });
});

describe('audit_logs', () => {
  it('shows users their own entries and admins their organisation', async () => {
    const aliceActions = await as<{ action: string }>(
      alice,
      'select action::text from public.audit_logs',
    );
    expect(aliceActions.map((r) => r.action)).toContain('CONNECTION_REQUESTED'); // carol's, in alice's org
    const bobRows = await as<{ actor_user_id: string }>(
      bob,
      'select actor_user_id from public.audit_logs',
    );
    expect(bobRows.length).toBeGreaterThan(0);
    expect(bobRows.every((r) => r.actor_user_id === bob.id)).toBe(true);
    const carolRows = await as<{ actor_user_id: string }>(
      carol,
      'select actor_user_id from public.audit_logs',
    );
    expect(carolRows.every((r) => r.actor_user_id === carol.id)).toBe(true);
  });

  it('is append-only', async () => {
    await expect(h.db.query(`update public.audit_logs set action = 'LOGIN'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(as(alice, 'delete from public.audit_logs')).rejects.toThrow(/permission denied/);
    await expect(
      as(alice, `insert into public.audit_logs (action) values ('LOGIN')`),
    ).rejects.toThrow(/permission denied/);
  });
});
