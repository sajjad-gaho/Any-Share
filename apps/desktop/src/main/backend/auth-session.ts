import {
  authResultSchema,
  userSchema,
  type AuthResult,
  type AuthTokens,
  type LoginInput,
  type PasswordResetConfirmInput,
  type RegisterInput,
  type SignupVerifyInput,
} from '@remote-desktop/shared';
import { z, type ZodType } from 'zod';
import type { AuthState, AuthUser } from '../../shared/ipc';
import { ApiError, type HttpClient, type HttpRequest } from './http';
import type { SecretStore } from './secret-store';

const REFRESH_TOKEN_KEY = 'auth.refreshToken';
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;

const anyBody = z.unknown();

/**
 * The signed-in session, owned by the main process.
 *  - Access token: memory only.
 *  - Refresh token: encrypted at rest (SecretStore), used to restore the
 *    session on the next launch.
 *  - The renderer only ever sees `AuthState` (who is signed in).
 */
export class AuthSession {
  private tokens: AuthTokens | null = null;
  private user: AuthUser | null = null;
  private restored: Promise<void> | null = null;
  private refreshing: Promise<boolean> | null = null;
  private readonly listeners = new Set<(state: AuthState) => void>();

  constructor(
    private readonly http: HttpClient,
    private readonly store: SecretStore,
    private readonly now: () => number = Date.now,
  ) {}

  onChange(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): AuthState {
    return this.user ? { status: 'signed-in', user: this.user } : { status: 'signed-out' };
  }

  /** Restores a saved session once per launch. Safe to call repeatedly. */
  async restore(): Promise<AuthState> {
    this.restored ??= (async () => {
      const refreshToken = await this.store.read(REFRESH_TOKEN_KEY);
      if (!refreshToken) return;
      try {
        await this.adopt(
          await this.http.request({
            method: 'POST',
            path: '/api/v1/auth/refresh',
            body: { refreshToken },
            schema: authResultSchema,
          }),
        );
      } catch (error) {
        // An offline start keeps the saved token for next time; a rejected one is discarded.
        if (!(error instanceof ApiError && error.code === 'network')) {
          await this.store.remove(REFRESH_TOKEN_KEY);
        }
      }
    })();
    await this.restored;
    return this.getState();
  }

  async login(input: LoginInput): Promise<AuthState> {
    await this.adopt(
      await this.http.request({
        method: 'POST',
        path: '/api/v1/auth/login',
        body: input,
        schema: authResultSchema,
      }),
    );
    return this.getState();
  }

  async register(input: RegisterInput): Promise<{ state: AuthState; needsConfirmation: boolean }> {
    const result = await this.http.request({
      method: 'POST',
      path: '/api/v1/auth/register',
      body: input,
      schema: authResultSchema,
    });
    if (!result.tokens) return { state: this.getState(), needsConfirmation: true };
    await this.adopt(result);
    return { state: this.getState(), needsConfirmation: false };
  }

  /** Confirms a new account with the code from the sign-up email, then signs in. */
  async verifySignup(input: SignupVerifyInput): Promise<AuthState> {
    await this.adopt(
      await this.http.request({
        method: 'POST',
        path: '/api/v1/auth/register/verify',
        body: input,
        schema: authResultSchema,
      }),
    );
    return this.getState();
  }

  async resendSignup(email: string): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: '/api/v1/auth/register/resend',
      body: { email },
      schema: anyBody,
    });
  }

  async logout(): Promise<void> {
    const token = this.tokens?.accessToken;
    await this.clear();
    if (token) {
      // Best effort: local state is already gone even if the server is unreachable.
      await this.http
        .request({
          method: 'POST',
          path: '/api/v1/auth/logout',
          accessToken: token,
          schema: anyBody,
        })
        .catch(() => undefined);
    }
  }

  async requestPasswordReset(email: string): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: '/api/v1/auth/password-reset',
      body: { email },
      schema: anyBody,
    });
  }

  async confirmPasswordReset(input: PasswordResetConfirmInput): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: '/api/v1/auth/password-reset/confirm',
      body: input,
      schema: anyBody,
    });
  }

  /**
   * A currently valid access token for other main-process clients (signaling),
   * refreshed shortly before expiry. Null when signed out. Never sent to the renderer.
   */
  async accessToken(): Promise<string | null> {
    await this.restore();
    if (!this.tokens) return null;
    if (this.tokens.expiresAt * 1000 - REFRESH_MARGIN_MS <= this.now()) {
      await this.refresh().catch(() => false);
    }
    return this.tokens?.accessToken ?? null;
  }

  /**
   * Calls the API as the signed-in user. Refreshes the access token shortly
   * before expiry, and once more on a 401; if that fails the session ends.
   */
  async authorized<T>(
    request: Omit<HttpRequest<T>, 'accessToken'> & { schema: ZodType<T> },
  ): Promise<T> {
    await this.restore();
    if (!this.tokens) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
    if (this.tokens.expiresAt * 1000 - REFRESH_MARGIN_MS <= this.now()) await this.refresh();
    const token = this.tokens?.accessToken;
    if (!token) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
    try {
      return await this.http.request({ ...request, accessToken: token });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
      if (!(await this.refresh()) || !this.tokens) throw error;
      return this.http.request({ ...request, accessToken: this.tokens.accessToken });
    }
  }

  /** Single-flight refresh. Returns false (and signs out) when the session is gone. */
  private refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      const refreshToken = this.tokens?.refreshToken;
      if (!refreshToken) return false;
      try {
        await this.adopt(
          await this.http.request({
            method: 'POST',
            path: '/api/v1/auth/refresh',
            body: { refreshToken },
            schema: authResultSchema,
          }),
        );
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.code === 'network') throw error;
        await this.clear();
        return false;
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async adopt(result: AuthResult): Promise<void> {
    if (!result.tokens) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
    this.tokens = result.tokens;
    await this.store.write(REFRESH_TOKEN_KEY, result.tokens.refreshToken);
    const me = await this.http.request({
      method: 'GET',
      path: '/api/v1/users/me',
      accessToken: result.tokens.accessToken,
      schema: userSchema,
    });
    this.user = {
      id: me.id,
      email: me.email,
      displayName: me.displayName,
      memberships: me.memberships,
    };
    this.emit();
  }

  private async clear(): Promise<void> {
    const wasSignedIn = this.user !== null;
    this.tokens = null;
    this.user = null;
    await this.store.remove(REFRESH_TOKEN_KEY);
    if (wasSignedIn) this.emit();
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}
