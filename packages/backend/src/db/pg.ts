import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { Db, Queryable } from './types';

export interface PgDbOptions {
  connectionString: string;
  ssl: boolean;
  /** PEM CA file: when set, the server certificate must chain to this CA (and only it). */
  sslCaFile?: string;
  max: number;
}

/** node-postgres implementation of `Db`. */
export function createPgDb(options: PgDbOptions): Db {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max,
    // Certificate verification always stays on. A custom CA pins trust; it is never a bypass.
    ssl: options.ssl
      ? {
          rejectUnauthorized: true,
          ca: options.sslCaFile ? readFileSync(options.sslCaFile, 'utf8') : undefined,
        }
      : undefined,
    // Fail fast instead of queueing forever when the database is unreachable.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
  });

  const query = async <T>(sql: string, params?: readonly unknown[]): Promise<T[]> => {
    const result = await pool.query(sql, params ? [...params] : undefined);
    return result.rows as T[];
  };

  return {
    query,
    async transaction(fn) {
      const client = await pool.connect();
      const tx: Queryable = {
        query: async <T>(sql: string, params?: readonly unknown[]) =>
          (await client.query(sql, params ? [...params] : undefined)).rows as T[],
      };
      try {
        await client.query('begin');
        const result = await fn(tx);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
