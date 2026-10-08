import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

export const APP_ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

/** Comma-separated ICE server URLs restricted to the given schemes. */
function iceUrlList(schemes: readonly string[]) {
  return z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(
          z
            .string()
            .max(256)
            .refine((url) => schemes.some((scheme) => url.startsWith(scheme)), {
              message: `Must start with ${schemes.join(' or ')}`,
            }),
        )
        .max(8),
    );
}

/**
 * Server configuration. Everything here is server-only: none of it may be
 * bundled into the Electron app. In particular the database URL carries
 * credentials, and the service-role key is not used at all.
 */
const envSchema = z
  .object({
    APP_ENV: z.enum(APP_ENVIRONMENTS).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),

    // Postgres (Supabase "Session" or "Transaction" pooler connection string).
    DATABASE_URL: z.string().url().optional(),
    DATABASE_SSL: bool.optional(),
    /**
     * PEM file of an extra CA to trust for the database (Supabase's pooler uses the
     * self-signed "Supabase Root 2021 CA": supabase/certs/prod-ca-2021.crt).
     * Verification is never disabled.
     */
    DATABASE_SSL_CA_FILE: z.string().min(1).optional(),
    DATABASE_POOL_MAX: int(1, 100).default(10),

    // Supabase Auth.
    SUPABASE_URL: z.string().url(),
    /** Publishable (anon) key: identifies the project to Supabase Auth. Not a secret. */
    SUPABASE_ANON_KEY: z.string().min(20),
    /** Only for projects still on the legacy shared HS256 JWT secret. Prefer JWKS. */
    SUPABASE_JWT_SECRET: z.string().min(32).optional(),
    SUPABASE_JWT_AUDIENCE: z.string().default('authenticated'),

    API_HOST: z.string().default('127.0.0.1'),
    API_PORT: int(1, 65535).default(8080),
    SIGNALING_HOST: z.string().default('127.0.0.1'),
    SIGNALING_PORT: int(1, 65535).default(8081),
    /**
     * Number of reverse proxies in front of the service (Caddy = 1). The client
     * IP is taken that many hops from the right of X-Forwarded-For, so a
     * client-supplied header cannot spoof it. `true` = 1, `false` = 0.
     */
    TRUST_PROXY: z
      .string()
      .regex(/^(true|false|[0-5])$/, 'true, false or a hop count 0-5')
      .default('false')
      .transform((value) => (value === 'true' ? 1 : value === 'false' ? 0 : Number(value))),

    CONNECTION_REQUEST_TTL_SECONDS: int(10, 600).default(60),
    /**
     * Scales every per-IP / per-account budget (load tests, staging). Defaults
     * per APP_ENV; production may only tighten (<= 1), never loosen.
     */
    RATE_LIMIT_MULTIPLIER: z.coerce.number().min(0.1).max(1000).optional(),
    HEARTBEAT_INTERVAL_MS: int(1_000, 120_000).default(15_000),
    PRESENCE_FLUSH_INTERVAL_MS: int(1_000, 600_000).default(30_000),

    // WebRTC. Comma-separated URL lists; empty means "not configured".
    STUN_URLS: iceUrlList(['stun:', 'stuns:']).default([]),
    TURN_URLS: iceUrlList(['turn:', 'turns:']).default([]),
    /** coturn `static-auth-secret` (use-auth-secret / TURN REST API). SECRET. */
    TURN_SECRET: z.string().min(32).optional(),
    TURN_CREDENTIAL_TTL_SECONDS: int(60, 86_400).default(3_600),
    /** An approved session must reach CONNECTED within this window. */
    SESSION_CONNECT_TIMEOUT_SECONDS: int(15, 600).default(90),
    /** How long a participant may be disconnected from signaling before its sessions fail. */
    PEER_DISCONNECT_GRACE_SECONDS: int(5, 300).default(30),
  })
  .superRefine((env, ctx) => {
    if (env.TURN_URLS.length > 0 && !env.TURN_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['TURN_SECRET'],
        message: 'Required when TURN_URLS is set',
      });
    }
    if (
      env.APP_ENV === 'production' &&
      env.TURN_URLS.length > 0 &&
      !env.TURN_URLS.some((url) => url.startsWith('turns:'))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['TURN_URLS'],
        message: 'Production needs at least one turns: (TLS) URL',
      });
    }
    if (env.APP_ENV !== 'test' && !env.DATABASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'Required' });
    }
    if (env.APP_ENV === 'production') {
      if (env.RATE_LIMIT_MULTIPLIER !== undefined && env.RATE_LIMIT_MULTIPLIER > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['RATE_LIMIT_MULTIPLIER'],
          message: 'Production rate limits can only be tightened (<= 1)',
        });
      }
      if (!env.SUPABASE_URL.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['SUPABASE_URL'],
          message: 'Must be https in production',
        });
      }
      if (env.DATABASE_SSL === false) {
        ctx.addIssue({
          code: 'custom',
          path: ['DATABASE_SSL'],
          message: 'TLS is required in production',
        });
      }
    }
  });

/** Per-environment defaults. Explicit env vars always win. */
const ENVIRONMENT_DEFAULTS: Record<
  AppEnvironment,
  { logLevel: string; prettyLogs: boolean; databaseSsl: boolean; rateLimitMultiplier: number }
> = {
  development: { logLevel: 'debug', prettyLogs: true, databaseSsl: false, rateLimitMultiplier: 5 },
  test: { logLevel: 'silent', prettyLogs: false, databaseSsl: false, rateLimitMultiplier: 1 },
  production: { logLevel: 'info', prettyLogs: false, databaseSsl: true, rateLimitMultiplier: 1 },
};

export interface ServerConfig {
  env: AppEnvironment;
  logLevel: string;
  prettyLogs: boolean;
  database: {
    url: string | undefined;
    ssl: boolean;
    sslCaFile: string | undefined;
    poolMax: number;
  };
  supabase: {
    url: string;
    anonKey: string;
    jwtSecret: string | undefined;
    jwtIssuer: string;
    jwtAudience: string;
    jwksUrl: string;
  };
  /** `trustProxy`: number of trusted reverse-proxy hops (0 = none). */
  api: { host: string; port: number; trustProxy: number };
  signaling: {
    host: string;
    port: number;
    heartbeatIntervalMs: number;
    presenceFlushIntervalMs: number;
    sessionConnectTimeoutSeconds: number;
    peerDisconnectGraceSeconds: number;
  };
  webrtc: {
    stunUrls: string[];
    turnUrls: string[];
    turnSecret: string | undefined;
    turnCredentialTtlSeconds: number;
  };
  connectionRequestTtlSeconds: number;
  /** Scales rate-limit budgets (looser in development). */
  rateLimitMultiplier: number;
}

export class ConfigError extends Error {
  constructor(issues: string[]) {
    super(`Invalid server configuration:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ServerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Report variable names and problems only, never values.
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  const e = parsed.data;
  const defaults = ENVIRONMENT_DEFAULTS[e.APP_ENV];
  const supabaseUrl = e.SUPABASE_URL.replace(/\/+$/, '');
  return {
    env: e.APP_ENV,
    logLevel: e.LOG_LEVEL ?? defaults.logLevel,
    prettyLogs: defaults.prettyLogs,
    database: {
      url: e.DATABASE_URL,
      ssl: e.DATABASE_SSL ?? defaults.databaseSsl,
      sslCaFile: e.DATABASE_SSL_CA_FILE,
      poolMax: e.DATABASE_POOL_MAX,
    },
    supabase: {
      url: supabaseUrl,
      anonKey: e.SUPABASE_ANON_KEY,
      jwtSecret: e.SUPABASE_JWT_SECRET,
      jwtIssuer: `${supabaseUrl}/auth/v1`,
      jwtAudience: e.SUPABASE_JWT_AUDIENCE,
      jwksUrl: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
    },
    api: { host: e.API_HOST, port: e.API_PORT, trustProxy: e.TRUST_PROXY },
    signaling: {
      host: e.SIGNALING_HOST,
      port: e.SIGNALING_PORT,
      heartbeatIntervalMs: e.HEARTBEAT_INTERVAL_MS,
      presenceFlushIntervalMs: e.PRESENCE_FLUSH_INTERVAL_MS,
      sessionConnectTimeoutSeconds: e.SESSION_CONNECT_TIMEOUT_SECONDS,
      peerDisconnectGraceSeconds: e.PEER_DISCONNECT_GRACE_SECONDS,
    },
    webrtc: {
      stunUrls: e.STUN_URLS,
      turnUrls: e.TURN_URLS,
      turnSecret: e.TURN_SECRET,
      turnCredentialTtlSeconds: e.TURN_CREDENTIAL_TTL_SECONDS,
    },
    connectionRequestTtlSeconds: e.CONNECTION_REQUEST_TTL_SECONDS,
    rateLimitMultiplier: e.RATE_LIMIT_MULTIPLIER ?? defaults.rateLimitMultiplier,
  };
}

/**
 * Loads `.env.<APP_ENV>.local`, `.env.<APP_ENV>` and `.env` from `dir` (in that
 * priority) into a copy of `base`. Variables already set in `base` always win,
 * so real deployment environments are never overridden by files.
 */
export function loadEnvFiles(
  dir: string,
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const appEnv = base['APP_ENV'] ?? 'development';
  const merged: Record<string, string | undefined> = { ...base };
  for (const name of [`.env.${appEnv}.local`, `.env.${appEnv}`, '.env']) {
    const file = resolve(dir, name);
    if (!existsSync(file)) continue;
    const values = parseEnv(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(values)) {
      if (merged[key] === undefined) merged[key] = value;
    }
  }
  return merged;
}
