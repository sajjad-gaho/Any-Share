import { pgErrorCode } from '../errors';
import type { Queryable } from './types';

/** Postgres `undefined_function`: the lookup function is not installed (yet). */
const UNDEFINED_FUNCTION = '42883';

/**
 * Narrow reads from Supabase's `auth` schema.
 *
 * With the least-privilege role `kestrel_api` (supabase/migrations-pending/
 * 20261008000200_api_role.sql) the services cannot read `auth.*` directly;
 * two SECURITY DEFINER functions answer exactly these questions instead.
 * Without that migration (the services connect as `postgres`, or tests on
 * PGlite) the functions do not exist and the tables are queried directly.
 */
const modes = new WeakMap<Queryable, 'function' | 'table'>();

async function viaFunction<T>(
  db: Queryable,
  fn: () => Promise<T>,
  table: () => Promise<T>,
): Promise<T> {
  if (modes.get(db) === 'table') return table();
  try {
    const result = await fn();
    modes.set(db, 'function');
    return result;
  } catch (error) {
    if (pgErrorCode(error) !== UNDEFINED_FUNCTION) throw error;
    modes.set(db, 'table');
    return table();
  }
}

/** Whether a Supabase Auth sign-in session still exists for this user. */
export async function isAuthSessionActive(
  db: Queryable,
  sessionId: string,
  userId: string,
): Promise<boolean> {
  return viaFunction(
    db,
    async () => {
      const [row] = await db.query<{ active: boolean }>(
        'select private.auth_session_active($1, $2) as active',
        [sessionId, userId],
      );
      return row?.active === true;
    },
    async () => {
      const [row] = await db.query(
        `select 1 from auth.sessions
          where id = $1 and user_id = $2 and (not_after is null or not_after > now())`,
        [sessionId, userId],
      );
      return row !== undefined;
    },
  );
}

/** The account id for an e-mail address (case-insensitive), or null. */
export async function userIdByEmail(db: Queryable, email: string): Promise<string | null> {
  return viaFunction(
    db,
    async () => {
      const [row] = await db.query<{ id: string | null }>(
        'select private.user_id_by_email($1) as id',
        [email],
      );
      return row?.id ?? null;
    },
    async () => {
      const [row] = await db.query<{ id: string }>(
        'select id from auth.users where lower(email) = lower($1)',
        [email],
      );
      return row?.id ?? null;
    },
  );
}
