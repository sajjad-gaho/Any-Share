import { createSupabaseAuthProvider } from './auth/auth-provider';
import { createSupabaseTokenVerifier } from './auth/token-verifier';
import type { ServerConfig } from './config';
import { createPgDb } from './db/pg';
import type { Db } from './db/types';
import type { Logger } from './logger';
import { createLimiters, type Limiters } from './security/rate-limiter';
import { createServices, type Services } from './services';

export interface Runtime {
  config: ServerConfig;
  logger: Logger;
  db: Db;
  limiters: Limiters;
  services: Services;
}

/** Wires production dependencies from configuration. */
export function createRuntime(config: ServerConfig, logger: Logger): Runtime {
  if (!config.database.url) throw new Error('DATABASE_URL is required');
  const db = createPgDb({
    connectionString: config.database.url,
    ssl: config.database.ssl,
    sslCaFile: config.database.sslCaFile,
    max: config.database.poolMax,
  });
  const limiters = createLimiters(config.rateLimitMultiplier);
  const services = createServices(
    {
      db,
      logger,
      limiters,
      settings: {
        connectionRequestTtlSeconds: config.connectionRequestTtlSeconds,
        presenceStaleAfterMs: config.signaling.presenceFlushIntervalMs * 3,
      },
    },
    {
      provider: createSupabaseAuthProvider({
        url: config.supabase.url,
        anonKey: config.supabase.anonKey,
      }),
      verifier: createSupabaseTokenVerifier({
        issuer: config.supabase.jwtIssuer,
        audience: config.supabase.jwtAudience,
        jwtSecret: config.supabase.jwtSecret,
        jwksUrl: config.supabase.jwksUrl,
      }),
      options: { checkSessionRevocation: true },
    },
  );
  return { config, logger, db, limiters, services };
}
