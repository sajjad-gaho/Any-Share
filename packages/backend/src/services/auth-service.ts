import type { AuthResult } from '@remote-desktop/shared';
import type { AuthProvider } from '../auth/auth-provider';
import type { TokenVerifier, VerifiedToken } from '../auth/token-verifier';
import { isAuthSessionActive } from '../db/auth-lookups';
import { AppError, PG, pgErrorCode, unauthenticated } from '../errors';
import type { AuditService } from './audit-service';
import type { RequestMeta, ServiceDeps } from './context';

export interface AuthContext {
  userId: string;
  email: string | null;
  sessionId: string | null;
  /** Unix seconds. */
  expiresAt: number;
  accessToken: string;
}

export interface AuthServiceOptions {
  /**
   * Check that the token's Supabase session still exists (`auth.sessions`), so
   * logout takes effect immediately rather than when the JWT expires.
   */
  checkSessionRevocation: boolean;
  /** Cache positive revocation checks for this long. */
  sessionCheckCacheMs?: number;
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export class AuthService {
  private readonly sessionCache = new Map<string, number>();
  private sessionCheckDisabled = false;

  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
    private readonly provider: AuthProvider,
    private readonly verifier: TokenVerifier,
    private readonly options: AuthServiceOptions,
  ) {}

  async register(input: {
    email: string;
    password: string;
    displayName: string;
  }): Promise<AuthResult> {
    return this.provider.signUp({ ...input, email: normalizeEmail(input.email) });
  }

  /**
   * Password login with brute-force protection keyed by account *and* by IP:
   * repeated failures lock the account key with exponential back-off, while
   * the IP key stops one source spraying many accounts.
   */
  async login(input: { email: string; password: string }, meta: RequestMeta): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    const guard = this.deps.limiters.loginGuard;
    const accountKey = `login:account:${email}`;
    const ipKey = `login:ip:${meta.ip ?? 'unknown'}`;
    guard.assertNotLocked(accountKey);
    guard.assertNotLocked(ipKey);

    let result: AuthResult;
    try {
      result = await this.provider.signInWithPassword({ email, password: input.password });
    } catch (error) {
      if (error instanceof AppError && error.code === 'unauthenticated') {
        guard.recordFailure(accountKey);
        guard.recordFailure(ipKey);
        this.deps.logger.warn({ ip: meta.ip }, 'Failed login attempt');
      }
      throw error;
    }
    guard.recordSuccess(accountKey);
    await this.audit.record(
      {
        action: 'LOGIN',
        actorUserId: result.user.id,
        targetType: 'user',
        targetId: result.user.id,
        metadata: { method: 'password', userAgent: meta.userAgent ?? null },
      },
      meta,
    );
    return result;
  }

  async refresh(refreshToken: string): Promise<AuthResult> {
    return this.provider.refresh(refreshToken);
  }

  async logout(context: AuthContext, meta: RequestMeta): Promise<void> {
    await this.provider.signOut(context.accessToken, 'local');
    if (context.sessionId) this.sessionCache.delete(context.sessionId);
    await this.audit.record(
      {
        action: 'LOGOUT',
        actorUserId: context.userId,
        targetType: 'user',
        targetId: context.userId,
      },
      meta,
    );
  }

  /** Always succeeds from the caller's point of view (no account enumeration). */
  async requestPasswordReset(email: string): Promise<void> {
    await this.provider.requestPasswordReset(normalizeEmail(email));
  }

  async confirmPasswordReset(
    input: { email: string; code: string; newPassword: string },
    meta: RequestMeta,
  ): Promise<void> {
    const email = normalizeEmail(input.email);
    const guard = this.deps.limiters.loginGuard;
    const key = `reset:account:${email}`;
    guard.assertNotLocked(key);
    try {
      await this.provider.confirmPasswordReset({ ...input, email });
    } catch (error) {
      if (error instanceof AppError && error.code === 'unauthenticated') {
        guard.recordFailure(key);
        this.deps.logger.warn({ ip: meta.ip }, 'Failed password reset attempt');
      }
      throw error;
    }
    guard.recordSuccess(key);
    guard.recordSuccess(`login:account:${email}`);
  }

  /**
   * Confirms a new account with the emailed code and signs it in. Wrong codes
   * lock the account key with the same back-off as failed logins.
   */
  async verifySignup(
    input: { email: string; code: string },
    meta: RequestMeta,
  ): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    const guard = this.deps.limiters.loginGuard;
    const key = `signup:account:${email}`;
    guard.assertNotLocked(key);
    let result: AuthResult;
    try {
      result = await this.provider.verifySignup({ email, code: input.code });
    } catch (error) {
      if (error instanceof AppError && error.code === 'unauthenticated') {
        guard.recordFailure(key);
        this.deps.logger.warn({ ip: meta.ip }, 'Failed sign-up confirmation');
      }
      throw error;
    }
    guard.recordSuccess(key);
    await this.audit.record(
      {
        action: 'LOGIN',
        actorUserId: result.user.id,
        targetType: 'user',
        targetId: result.user.id,
        metadata: { method: 'email_code', userAgent: meta.userAgent ?? null },
      },
      meta,
    );
    return result;
  }

  /** Always succeeds from the caller's point of view (no account enumeration). */
  async resendSignup(email: string): Promise<void> {
    await this.provider.resendSignup(normalizeEmail(email));
  }

  /** Verifies an access token and returns the caller. The only source of user identity. */
  async authenticate(accessToken: string): Promise<AuthContext> {
    const verified = await this.verifier.verify(accessToken);
    await this.assertSessionActive(verified);
    return { ...verified, accessToken };
  }

  /**
   * Re-checks, for a long-lived connection, that the Supabase session behind an
   * already verified token has not been signed out. Throws `unauthenticated`.
   */
  async assertStillSignedIn(token: Pick<VerifiedToken, 'userId' | 'sessionId'>): Promise<void> {
    await this.assertSessionActive(token);
  }

  private async assertSessionActive(
    token: Pick<VerifiedToken, 'userId' | 'sessionId'>,
  ): Promise<void> {
    if (!this.options.checkSessionRevocation || this.sessionCheckDisabled || !token.sessionId) {
      return;
    }
    const cachedUntil = this.sessionCache.get(token.sessionId);
    if (cachedUntil !== undefined && cachedUntil > Date.now()) return;

    try {
      const active = await isAuthSessionActive(this.deps.db, token.sessionId, token.userId);
      if (!active) {
        this.sessionCache.delete(token.sessionId);
        throw unauthenticated('Session has been signed out');
      }
    } catch (error) {
      if (pgErrorCode(error) === PG.insufficientPrivilege) {
        // The database role cannot read auth.sessions; fall back to JWT expiry.
        this.sessionCheckDisabled = true;
        this.deps.logger.warn('auth.sessions is not readable; logout relies on token expiry');
        return;
      }
      throw error;
    }
    if (this.sessionCache.size > 10_000) this.sessionCache.clear();
    this.sessionCache.set(
      token.sessionId,
      Date.now() + (this.options.sessionCheckCacheMs ?? 15_000),
    );
  }
}
