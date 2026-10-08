import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Db, Queryable } from '../db/types';

const SUPABASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../supabase');

/** Serialises parameters the way node-postgres does, so SQL behaves identically. */
function toPgParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      if (item === null || item === undefined) return 'NULL';
      return `"${String(item).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    });
    return `{${items.join(',')}}`;
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

function wrap(target: PGlite | Transaction): Queryable {
  return {
    async query<T>(sql: string, params?: readonly unknown[]) {
      const result = await target.query<T>(sql, params?.map(toPgParam));
      return result.rows;
    },
  };
}

export interface TestDb extends Db {
  pg: PGlite;
  exec(sql: string): Promise<void>;
}

/**
 * Fresh in-memory Postgres with the Supabase shim and every migration in
 * `supabase/migrations` applied, in filename order — the same files that are
 * deployed to the real project.
 */
export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  await pg.exec(readFileSync(resolve(SUPABASE_DIR, 'tests/supabase-shim.sql'), 'utf8'));
  const migrations = readdirSync(resolve(SUPABASE_DIR, 'migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of migrations) {
    try {
      await pg.exec(readFileSync(resolve(SUPABASE_DIR, 'migrations', file), 'utf8'));
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }
  const root = wrap(pg);
  return {
    pg,
    query: root.query,
    async exec(sql) {
      await pg.exec(sql);
    },
    async transaction(fn) {
      return pg.transaction((tx) => fn(wrap(tx)));
    },
    async close() {
      await pg.close();
    },
  };
}
