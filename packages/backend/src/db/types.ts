/**
 * Minimal database surface used by the services. Implemented by node-postgres
 * in production (`pg.ts`) and by PGlite in tests (`testing/pglite.ts`), so the
 * same SQL, triggers and RLS policies run in both.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  /** Runs `fn` in a transaction on the privileged connection (RLS not applied). */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Runs `fn` in a transaction as the `authenticated` role with `auth.uid()` set
 * to `userId` — exactly how Supabase's Data API executes a user's request — so
 * row level security filters every read. Use this for anything returned to a
 * user; use the privileged connection only for writes the service has
 * already authorised.
 */
export async function asUser<T>(
  db: Db,
  userId: string,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    await tx.query('set local role authenticated');
    return fn(tx);
  });
}

export async function one<T>(promise: Promise<T[]>): Promise<T | undefined> {
  const rows = await promise;
  return rows[0];
}
