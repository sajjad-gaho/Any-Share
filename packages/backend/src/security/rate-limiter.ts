import { rateLimited } from '../errors';

/**
 * In-memory limiters. Correct for a single instance of each service; when the
 * API or signaling service is scaled horizontally these move to a shared store
 * (e.g. Redis) behind the same interfaces.
 */

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/** Fixed-window counter: at most `limit` hits per `windowMs` per key. */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly clock: Clock = systemClock,
  ) {}

  consume(key: string, cost = 1): RateLimitResult {
    const now = this.clock.now();
    this.sweep(now);
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, window);
    }
    window.count += cost;
    const allowed = window.count <= this.limit;
    return {
      allowed,
      remaining: Math.max(0, this.limit - window.count),
      retryAfterSeconds: allowed ? 0 : Math.ceil((window.resetAt - now) / 1000),
    };
  }

  /** Throws `rate_limited` when the budget is exhausted. */
  consumeOrThrow(key: string, cost = 1): void {
    const result = this.consume(key, cost);
    if (!result.allowed) throw rateLimited(result.retryAfterSeconds);
  }

  private lastSweep = 0;
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}

export interface BruteForceOptions {
  /** Failures allowed inside `windowMs` before the key is locked. */
  maxFailures: number;
  windowMs: number;
  /** First lockout; doubles on each further lockout, up to `maxLockMs`. */
  baseLockMs: number;
  maxLockMs: number;
}

/**
 * Locks a key (e.g. `login:<email>` or `login-ip:<ip>`) after repeated
 * failures, with exponential back-off. Success clears the record.
 */
export class BruteForceGuard {
  private readonly records = new Map<
    string,
    { failures: number; firstFailureAt: number; lockedUntil: number; lockouts: number }
  >();

  constructor(
    private readonly options: BruteForceOptions,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Throws `rate_limited` while the key is locked. */
  assertNotLocked(key: string): void {
    const record = this.records.get(key);
    const now = this.clock.now();
    if (record && record.lockedUntil > now) {
      throw rateLimited(Math.ceil((record.lockedUntil - now) / 1000));
    }
  }

  recordFailure(key: string): void {
    const now = this.clock.now();
    let record = this.records.get(key);
    if (!record || now - record.firstFailureAt > this.options.windowMs) {
      record = {
        failures: 0,
        firstFailureAt: now,
        lockedUntil: 0,
        lockouts: record?.lockouts ?? 0,
      };
      this.records.set(key, record);
    }
    record.failures += 1;
    if (record.failures >= this.options.maxFailures) {
      const lockMs = Math.min(
        this.options.baseLockMs * 2 ** record.lockouts,
        this.options.maxLockMs,
      );
      record.lockedUntil = now + lockMs;
      record.lockouts += 1;
      record.failures = 0;
      record.firstFailureAt = now;
    }
  }

  recordSuccess(key: string): void {
    this.records.delete(key);
  }
}

/** Rate-limit budgets used across the API and signaling service. */
export function createLimiters(multiplier = 1, clock: Clock = systemClock) {
  const n = (value: number) => Math.max(1, Math.round(value * multiplier));
  return {
    /** Login, register, password reset: per IP. */
    authByIp: new RateLimiter(n(20), 60_000, clock),
    /** Account-level brute-force protection on login and reset confirmation. */
    loginGuard: new BruteForceGuard(
      { maxFailures: 5, windowMs: 15 * 60_000, baseLockMs: 60_000, maxLockMs: 60 * 60_000 },
      clock,
    ),
    deviceRegistration: new RateLimiter(n(10), 60 * 60_000, clock),
    deviceLookup: new RateLimiter(n(60), 60_000, clock),
    connectionRequests: new RateLimiter(n(10), 60_000, clock),
    /** Wrong device access passwords, per target device. */
    accessPasswordGuard: new BruteForceGuard(
      { maxFailures: 5, windowMs: 15 * 60_000, baseLockMs: 5 * 60_000, maxLockMs: 60 * 60_000 },
      clock,
    ),
    wsAuthByIp: new RateLimiter(n(30), 60_000, clock),
    wsMessagesPerConnection: new RateLimiter(n(120), 10_000, clock),
  };
}
export type Limiters = ReturnType<typeof createLimiters>;
