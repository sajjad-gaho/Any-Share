import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness, type TestUser } from '../testing';
import { isAuthSessionActive, userIdByEmail } from './auth-lookups';
import type { Queryable } from './types';

/**
 * Phase 4 migrations (applied to PBS-DESKTOP on 2026-10-08). The harness
 * already applies every file in supabase/migrations; these tests check what
 * they claim and that re-running them is harmless.
 */
const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations',
);
const PHASE4 = ['20261008000100_fk_indexes.sql', '20261008000200_api_role.sql'];
const runPhase4 = async () => {
  const exec = (h.db as unknown as { exec(sql: string): Promise<void> }).exec.bind(h.db);
  for (const file of PHASE4) await exec(readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8'));
};

let h: TestHarness;
let user: TestUser;
let sessionId: string;

/** A fresh Queryable (its own lookup-mode cache) that records the SQL it runs. */
function recording(): Queryable & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    query: (text, params) => {
      sql.push(text);
      return h.db.query(text, params);
    },
  };
}

/** Runs `statement` as `role` in its own transaction and returns the error code, if any. */
async function asRole(role: string, statement: string, params: unknown[] = []) {
  try {
    await h.db.transaction(async (tx) => {
      await tx.query(`set local role ${role}`);
      await tx.query(statement, params);
    });
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'error';
  }
}

beforeAll(async () => {
  h = await createTestHarness();
  user = await h.createUser('Pending');
  const payload = JSON.parse(
    Buffer.from(user.accessToken.split('.')[1] ?? '', 'base64url').toString(),
  ) as { session_id: string };
  sessionId = payload.session_id;
});

afterAll(async () => {
  await h.close();
});

describe('auth lookups without the lookup functions', () => {
  it('fall back to reading auth.* directly', async () => {
    // As on a database where 20261008000200 is not applied yet.
    await h.db.query('drop function private.auth_session_active(uuid, uuid)');
    await h.db.query('drop function private.user_id_by_email(text)');
    const db = recording();
    expect(await isAuthSessionActive(db, sessionId, user.id)).toBe(true);
    expect(await userIdByEmail(db, user.email.toUpperCase())).toBe(user.id);
    expect(db.sql.some((s) => s.includes('from auth.sessions'))).toBe(true);
  });
});

describe('phase 4 migrations', () => {
  beforeAll(async () => {
    await runPhase4(); // restores the functions dropped above
  });

  it('are idempotent', async () => {
    await expect(runPhase4()).resolves.toBeUndefined();
  });

  it('add the foreign-key indexes', async () => {
    const rows = await h.db.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and indexname = any($1)`,
      [
        [
          'connection_requests_controller_device_id_idx',
          'connection_requests_responded_by_idx',
          'device_permissions_granted_by_idx',
          'organizations_created_by_idx',
          'session_permissions_granted_by_idx',
          'sessions_controller_device_id_idx',
          'sessions_organization_id_idx',
        ],
      ],
    );
    expect(rows).toHaveLength(7);
  });

  it('auth lookups then use the narrow functions', async () => {
    const db = recording();
    expect(await isAuthSessionActive(db, sessionId, user.id)).toBe(true);
    expect(await userIdByEmail(db, user.email.toUpperCase())).toBe(user.id);
    expect(await userIdByEmail(db, 'nobody@example.test')).toBeNull();
    expect(db.sql.every((s) => !s.includes('from auth.'))).toBe(true);
  });

  it('kestrel_api reads and writes the application tables', async () => {
    expect(await asRole('kestrel_api', 'select count(*) from public.devices')).toBeNull();
    expect(await asRole('kestrel_api', 'select count(*) from public.audit_logs')).toBeNull();
    expect(
      await asRole('kestrel_api', 'update public.profiles set display_name = display_name'),
    ).toBeNull();
    expect(
      await asRole('kestrel_api', 'select private.auth_session_active($1, $2)', [
        sessionId,
        user.id,
      ]),
    ).toBeNull();
    // asUser: may switch to `authenticated` for RLS-scoped queries.
    expect(await asRole('kestrel_api', 'set local role authenticated')).toBeNull();
  });

  it('kestrel_api cannot rewrite the audit log, change the schema or read auth.*', async () => {
    const denied = '42501';
    expect(await asRole('kestrel_api', 'update public.audit_logs set action = action')).toBe(
      denied,
    );
    expect(await asRole('kestrel_api', 'delete from public.audit_logs')).toBe(denied);
    expect(await asRole('kestrel_api', 'drop table public.devices')).toBe(denied);
    expect(
      await asRole('kestrel_api', 'alter table public.devices disable row level security'),
    ).toBe(denied);
    expect(await asRole('kestrel_api', 'create table public.kestrel_probe (id int)')).toBe(denied);
    expect(await asRole('kestrel_api', 'select * from auth.users')).toBe(denied);
    expect(await asRole('kestrel_api', 'select * from auth.sessions')).toBe(denied);
  });

  it('only kestrel_api may call the auth lookup functions', async () => {
    const denied = '42501';
    expect(await asRole('authenticated', "select private.user_id_by_email('x@y.z')")).toBe(denied);
    expect(
      await asRole('authenticated', 'select private.auth_session_active($1, $2)', [
        sessionId,
        user.id,
      ]),
    ).toBe(denied);
  });
});
