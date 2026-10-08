import { generateKeyPairSync, sign } from 'node:crypto';
import { isValidDeviceId } from '@remote-desktop/shared';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../config';
import { AppError } from '../errors';
import { hashSecret, verifySecret } from './argon2';
import {
  generateDeviceCode,
  parseDevicePublicKey,
  publicKeyFingerprint,
  verifyDeviceSignature,
} from './device-identity';
import { BruteForceGuard, RateLimiter, type Clock } from './rate-limiter';
import { sanitizeAuditMetadata } from './sanitize';

function manualClock(start = 1_000_000): Clock & { advance(ms: number): void } {
  let now = start;
  return { now: () => now, advance: (ms) => void (now += ms) };
}

describe('argon2id', () => {
  it('hashes with argon2id and verifies', async () => {
    const hash = await hashSecret('device access password');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('device access password');
    expect(await verifySecret(hash, 'device access password')).toBe(true);
    expect(await verifySecret(hash, 'wrong password')).toBe(false);
  });

  it('salts every hash and rejects malformed hashes', async () => {
    expect(await hashSecret('same')).not.toBe(await hashSecret('same'));
    expect(await verifySecret('plaintext', 'plaintext')).toBe(false);
    expect(await verifySecret('$argon2id$garbage', 'x')).toBe(false);
  });
});

describe('device identity', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

  it('generates valid, random device codes', () => {
    const codes = new Set(Array.from({ length: 200 }, generateDeviceCode));
    expect(codes.size).toBeGreaterThan(195);
    for (const code of codes) expect(isValidDeviceId(code)).toBe(true);
  });

  it('accepts Ed25519 keys only', () => {
    expect(parseDevicePublicKey(spki).asymmetricKeyType).toBe('ed25519');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey;
    expect(() =>
      parseDevicePublicKey(rsa.export({ format: 'der', type: 'spki' }).toString('base64')),
    ).toThrow(AppError);
    expect(() => parseDevicePublicKey('bm90IGEga2V5')).toThrow(AppError);
  });

  it('fingerprints keys deterministically', () => {
    expect(publicKeyFingerprint(spki)).toMatch(/^[0-9a-f]{64}$/);
    expect(publicKeyFingerprint(spki)).toBe(publicKeyFingerprint(spki));
  });

  it('verifies signatures from the matching key only', () => {
    const signature = sign(null, Buffer.from('nonce'), privateKey).toString('base64');
    expect(verifyDeviceSignature(spki, 'nonce', signature)).toBe(true);
    expect(verifyDeviceSignature(spki, 'other nonce', signature)).toBe(false);
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
    expect(verifyDeviceSignature(other.toString('base64'), 'nonce', signature)).toBe(false);
    expect(verifyDeviceSignature(spki, 'nonce', 'AAAA')).toBe(false);
  });
});

describe('RateLimiter', () => {
  it('allows the budget, then blocks until the window resets', () => {
    const clock = manualClock();
    const limiter = new RateLimiter(3, 1000, clock);
    expect([1, 2, 3].map(() => limiter.consume('a').allowed)).toEqual([true, true, true]);
    const blocked = limiter.consume('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);
    expect(limiter.consume('b').allowed).toBe(true);
    clock.advance(1000);
    expect(limiter.consume('a').allowed).toBe(true);
  });

  it('throws rate_limited from consumeOrThrow', () => {
    const limiter = new RateLimiter(1, 1000, manualClock());
    limiter.consumeOrThrow('k');
    expect(() => limiter.consumeOrThrow('k')).toThrow(
      expect.objectContaining({ code: 'rate_limited', statusCode: 429 }),
    );
  });
});

describe('BruteForceGuard', () => {
  const options = { maxFailures: 3, windowMs: 60_000, baseLockMs: 1_000, maxLockMs: 3_000 };

  it('locks after repeated failures with exponential back-off', () => {
    const clock = manualClock();
    const guard = new BruteForceGuard(options, clock);
    for (let i = 0; i < 3; i++) guard.recordFailure('k');
    expect(() => guard.assertNotLocked('k')).toThrow(AppError);
    clock.advance(1_000);
    expect(() => guard.assertNotLocked('k')).not.toThrow();
    for (let i = 0; i < 3; i++) guard.recordFailure('k');
    clock.advance(1_000);
    expect(() => guard.assertNotLocked('k')).toThrow(AppError); // second lock is 2s
    clock.advance(1_000);
    expect(() => guard.assertNotLocked('k')).not.toThrow();
  });

  it('clears on success and isolates keys', () => {
    const guard = new BruteForceGuard(options, manualClock());
    guard.recordFailure('k');
    guard.recordFailure('k');
    guard.recordSuccess('k');
    guard.recordFailure('k');
    guard.recordFailure('k');
    expect(() => guard.assertNotLocked('k')).not.toThrow();
    for (let i = 0; i < 3; i++) guard.recordFailure('other');
    expect(() => guard.assertNotLocked('k')).not.toThrow();
  });
});

describe('sanitizeAuditMetadata', () => {
  it('drops secrets, user content and nested values', () => {
    expect(
      sanitizeAuditMetadata({
        password: 'hunter2',
        accessPassword: 'x',
        accessToken: 'jwt',
        refresh_token: 'r',
        privateKey: 'k',
        clipboard: 'copied text',
        fileContent: 'bytes',
        sdp: 'v=0',
        code: '123456',
        nested: { a: 1 },
        list: [1],
        deviceCode: '123456782',
        permissions: 'screen_view',
        durationMs: 5,
        ok: true,
        none: null,
      }),
    ).toEqual({
      deviceCode: '123456782',
      permissions: 'screen_view',
      durationMs: 5,
      ok: true,
      none: null,
    });
  });

  it('truncates long strings', () => {
    expect(sanitizeAuditMetadata({ note: 'x'.repeat(2000) }).note).toHaveLength(500);
  });
});

describe('loadConfig', () => {
  const base = {
    SUPABASE_URL: 'https://wqomqigjotnkdlheccxl.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_xxxxxxxxxxxxxxxxxxxx',
    DATABASE_URL: 'postgresql://postgres:pw@localhost:5432/postgres',
  };

  it('applies per-environment defaults', () => {
    expect(loadConfig({ ...base, APP_ENV: 'development' })).toMatchObject({
      env: 'development',
      logLevel: 'debug',
      database: { ssl: false },
    });
    expect(loadConfig({ ...base, APP_ENV: 'production' })).toMatchObject({
      env: 'production',
      logLevel: 'info',
      database: { ssl: true },
      rateLimitMultiplier: 1,
    });
  });

  it('derives Supabase auth endpoints', () => {
    const config = loadConfig({ ...base, SUPABASE_URL: `${base.SUPABASE_URL}/` });
    expect(config.supabase.jwtIssuer).toBe(`${base.SUPABASE_URL}/auth/v1`);
    expect(config.supabase.jwksUrl).toBe(`${base.SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
  });

  it('rejects unsafe production settings without echoing values', () => {
    const attempt = () =>
      loadConfig({
        ...base,
        APP_ENV: 'production',
        SUPABASE_URL: 'http://insecure.example.com',
        DATABASE_SSL: 'false',
      });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/SUPABASE_URL/);
    expect(attempt).not.toThrow(/insecure\.example\.com/);
  });

  it('reads TRUST_PROXY as a hop count', () => {
    expect(loadConfig({ ...base }).api.trustProxy).toBe(0);
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).api.trustProxy).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY: '2' }).api.trustProxy).toBe(2);
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/);
  });

  it('lets production tighten rate limits but never loosen them', () => {
    expect(loadConfig({ ...base, APP_ENV: 'test', RATE_LIMIT_MULTIPLIER: '50' })).toMatchObject({
      rateLimitMultiplier: 50,
    });
    expect(
      loadConfig({ ...base, APP_ENV: 'production', RATE_LIMIT_MULTIPLIER: '0.5' }),
    ).toMatchObject({ rateLimitMultiplier: 0.5 });
    expect(() =>
      loadConfig({ ...base, APP_ENV: 'production', RATE_LIMIT_MULTIPLIER: '10' }),
    ).toThrow(/RATE_LIMIT_MULTIPLIER/);
  });

  it('requires a database URL outside tests', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, DATABASE_URL: undefined, APP_ENV: 'test' })).not.toThrow();
  });
});
