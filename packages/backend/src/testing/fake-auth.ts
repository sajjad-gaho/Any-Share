import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { AuthResult } from '@remote-desktop/shared';
import { SignJWT } from 'jose';
import type { AuthProvider } from '../auth/auth-provider';
import type { Db } from '../db/types';
import { badRequest, unauthenticated } from '../errors';

export const TEST_SUPABASE_URL = 'http://supabase.test';
export const TEST_JWT_ISSUER = `${TEST_SUPABASE_URL}/auth/v1`;
export const TEST_JWT_SECRET = 'test-only-jwt-secret-that-is-long-enough-0123456789';

/**
 * Stand-in for Supabase Auth. It writes real rows to `auth.users` (so the
 * `on_auth_user_created` trigger creates profiles) and `auth.sessions` (so
 * logout revocation is exercised), and issues HS256 JWTs shaped like
 * Supabase's, verified by the production token verifier.
 */
export class FakeAuthProvider implements AuthProvider {
  private readonly passwords = new Map<string, string>();
  private readonly refreshTokens = new Map<string, { userId: string; sessionId: string }>();
  private readonly resetCodes = new Map<string, string>();
  readonly calls: string[] = [];

  constructor(
    private readonly db: Db,
    private readonly tokenTtlSeconds = 3600,
  ) {}

  async signUp(input: { email: string; password: string; displayName: string }) {
    this.calls.push('signUp');
    const [existing] = await this.db.query('select 1 from auth.users where email = $1', [
      input.email,
    ]);
    if (existing) throw badRequest('Registration failed.');
    const [user] = await this.db.query<{ id: string }>(
      'insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id',
      [input.email, JSON.stringify({ display_name: input.displayName })],
    );
    if (!user) throw new Error('insert failed');
    this.passwords.set(input.email, input.password);
    return this.issue(user.id, input.email);
  }

  async signInWithPassword(input: { email: string; password: string }) {
    this.calls.push('signIn');
    const [user] = await this.db.query<{ id: string }>(
      'select id from auth.users where email = $1',
      [input.email],
    );
    if (!user || this.passwords.get(input.email) !== input.password) {
      throw unauthenticated('Invalid email or password');
    }
    return this.issue(user.id, input.email);
  }

  async refresh(refreshToken: string) {
    const entry = this.refreshTokens.get(refreshToken);
    if (!entry) throw unauthenticated('Session expired');
    this.refreshTokens.delete(refreshToken);
    const [user] = await this.db.query<{ email: string }>(
      'select email from auth.users where id = $1',
      [entry.userId],
    );
    const [session] = await this.db.query('select 1 from auth.sessions where id = $1', [
      entry.sessionId,
    ]);
    if (!user || !session) throw unauthenticated('Session expired');
    return this.tokensFor(entry.userId, user.email, entry.sessionId);
  }

  async signOut(accessToken: string, scope: 'local' | 'global' = 'local') {
    this.calls.push(`signOut:${scope}`);
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { sub?: string; session_id?: string };
    if (scope === 'global' && payload.sub) {
      await this.db.query('delete from auth.sessions where user_id = $1', [payload.sub]);
    } else if (payload.session_id) {
      await this.db.query('delete from auth.sessions where id = $1', [payload.session_id]);
    }
  }

  async requestPasswordReset(email: string) {
    this.calls.push('recover');
    const [user] = await this.db.query('select 1 from auth.users where email = $1', [email]);
    if (user) this.resetCodes.set(email, String(randomInt(100000, 999999)));
  }

  async confirmPasswordReset(input: { email: string; code: string; newPassword: string }) {
    if (this.resetCodes.get(input.email) !== input.code) {
      throw unauthenticated('Invalid or expired code');
    }
    this.resetCodes.delete(input.email);
    this.passwords.set(input.email, input.newPassword);
    await this.db.query(
      'delete from auth.sessions where user_id = (select id from auth.users where email = $1)',
      [input.email],
    );
  }

  /** Test helper: the code the recovery email would have contained. */
  resetCodeFor(email: string): string | undefined {
    return this.resetCodes.get(email);
  }

  private async issue(userId: string, email: string): Promise<AuthResult> {
    const [session] = await this.db.query<{ id: string }>(
      'insert into auth.sessions (user_id) values ($1) returning id',
      [userId],
    );
    if (!session) throw new Error('insert failed');
    return this.tokensFor(userId, email, session.id);
  }

  private async tokensFor(userId: string, email: string, sessionId: string): Promise<AuthResult> {
    const expiresAt = Math.floor(Date.now() / 1000) + this.tokenTtlSeconds;
    const accessToken = await signTestToken(
      { sub: userId, email, session_id: sessionId },
      expiresAt,
    );
    const refreshToken = randomBytes(24).toString('base64url');
    this.refreshTokens.set(refreshToken, { userId, sessionId });
    return { user: { id: userId, email }, tokens: { accessToken, refreshToken, expiresAt } };
  }
}

/** Signs a Supabase-shaped access token with the test secret. */
export async function signTestToken(
  claims: Record<string, unknown>,
  expiresAt = Math.floor(Date.now() / 1000) + 3600,
  overrides: { issuer?: string; audience?: string; secret?: string } = {},
): Promise<string> {
  return new SignJWT({ role: 'authenticated', ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(overrides.issuer ?? TEST_JWT_ISSUER)
    .setAudience(overrides.audience ?? 'authenticated')
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .setJti(randomUUID())
    .sign(new TextEncoder().encode(overrides.secret ?? TEST_JWT_SECRET));
}
