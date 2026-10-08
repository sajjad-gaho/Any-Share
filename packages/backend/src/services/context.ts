import type { Db } from '../db/types';
import type { Logger } from '../logger';
import type { Limiters } from '../security/rate-limiter';

export interface ServiceSettings {
  connectionRequestTtlSeconds: number;
  /** A device whose last_seen_at is older than this is reported offline. */
  presenceStaleAfterMs: number;
}

export interface ServiceDeps {
  db: Db;
  logger: Logger;
  limiters: Limiters;
  settings: ServiceSettings;
}

/** Facts about the caller's request that are recorded in the audit log. */
export interface RequestMeta {
  ip: string | null;
  userAgent?: string | null;
}

export const NO_REQUEST_META: RequestMeta = { ip: null };

export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  throw new TypeError('Expected a timestamp');
}

export function toIsoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toIso(value);
}
