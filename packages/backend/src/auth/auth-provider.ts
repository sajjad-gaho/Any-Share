import type { AuthResult, AuthTokens } from '@remote-desktop/shared';
import { z } from 'zod';
import { AppError, badRequest, rateLimited, unauthenticated } from '../errors';

/**
 * Identity provider operations. Production: Supabase Auth (GoTrue) over HTTPS
 * with the project's publishable key only. Tests: `FakeAuthProvider`.
 */
export interface AuthProvider {
  signUp(input: { email: string; password: string; displayName: string }): Promise<AuthResult>;
  signInWithPassword(input: { email: string; password: string }): Promise<AuthResult>;
  refresh(refreshToken: string): Promise<AuthResult>;
  /** Revokes the session the access token belongs to (`scope: local`) or all of them. */
  signOut(accessToken: string, scope?: 'local' | 'global'): Promise<void>;
  /** Sends a recovery email containing a one-time code. */
  requestPasswordReset(email: string): Promise<void>;
  /** Verifies the recovery code, sets the new password and signs out every session. */
  confirmPasswordReset(input: { email: string; code: string; newPassword: string }): Promise<void>;
}

const sessionResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number().optional(),
  expires_in: z.number().optional(),
  user: z.object({ id: z.uuid(), email: z.string() }),
});
const userResponseSchema = z.object({ id: z.uuid(), email: z.string() });
const errorResponseSchema = z
  .object({
    error_code: z.string().optional(),
    code: z.union([z.string(), z.number()]).optional(),
    msg: z.string().optional(),
    error_description: z.string().optional(),
  })
  .loose();

function toTokens(session: z.infer<typeof sessionResponseSchema>): AuthTokens {
  const expiresAt =
    session.expires_at ?? Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600);
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt,
  };
}

export interface SupabaseAuthProviderOptions {
  url: string;
  anonKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createSupabaseAuthProvider(options: SupabaseAuthProviderOptions): AuthProvider {
  const doFetch = options.fetch ?? fetch;
  const base = `${options.url}/auth/v1`;

  async function call(
    path: string,
    init: { method?: string; body?: unknown; accessToken?: string },
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      apikey: options.anonKey,
      'content-type': 'application/json',
    };
    if (init.accessToken) headers['authorization'] = `Bearer ${init.accessToken}`;
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method: init.method ?? 'POST',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch {
      throw new AppError('unavailable', 'Authentication service is unavailable');
    }
    const text = await response.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new AppError('unavailable', 'Authentication service returned an invalid response');
    }
    if (response.ok) return json;

    const parsed = errorResponseSchema.safeParse(json);
    const code = parsed.success ? (parsed.data.error_code ?? String(parsed.data.code ?? '')) : '';
    if (response.status === 429) throw rateLimited(60);
    if (response.status >= 500) {
      throw new AppError('unavailable', 'Authentication service is unavailable');
    }
    throw new GoTrueError(response.status, code);
  }

  return {
    async signUp({ email, password, displayName }) {
      try {
        const json = await call('/signup', {
          body: { email, password, data: { display_name: displayName } },
        });
        const session = sessionResponseSchema.safeParse(json);
        if (session.success) return { user: session.data.user, tokens: toTokens(session.data) };
        // Email confirmation is enabled: the account exists but has no session yet.
        const user = userResponseSchema.parse(json);
        return { user, tokens: null };
      } catch (error) {
        if (error instanceof GoTrueError) {
          if (error.code === 'weak_password') throw badRequest('Choose a stronger password');
          // Deliberately vague: do not reveal whether the email is registered.
          throw badRequest(
            'Registration failed. If you already have an account, sign in or reset your password.',
          );
        }
        throw error;
      }
    },

    async signInWithPassword({ email, password }) {
      try {
        const json = await call('/token?grant_type=password', { body: { email, password } });
        const session = sessionResponseSchema.parse(json);
        return { user: session.user, tokens: toTokens(session) };
      } catch (error) {
        if (error instanceof GoTrueError) {
          if (error.code === 'email_not_confirmed') {
            throw unauthenticated('Confirm your email address before signing in');
          }
          throw unauthenticated('Invalid email or password');
        }
        throw error;
      }
    },

    async refresh(refreshToken) {
      try {
        const json = await call('/token?grant_type=refresh_token', {
          body: { refresh_token: refreshToken },
        });
        const session = sessionResponseSchema.parse(json);
        return { user: session.user, tokens: toTokens(session) };
      } catch (error) {
        if (error instanceof GoTrueError) throw unauthenticated('Session expired');
        throw error;
      }
    },

    async signOut(accessToken, scope = 'local') {
      try {
        await call(`/logout?scope=${scope}`, { accessToken });
      } catch (error) {
        // An already-invalid token is as signed out as it gets.
        if (error instanceof GoTrueError) return;
        throw error;
      }
    },

    async requestPasswordReset(email) {
      try {
        await call('/recover', { body: { email } });
      } catch (error) {
        // Never reveal whether the address exists.
        if (error instanceof GoTrueError) return;
        throw error;
      }
    },

    async confirmPasswordReset({ email, code, newPassword }) {
      let accessToken: string;
      try {
        const json = await call('/verify', { body: { type: 'recovery', email, token: code } });
        accessToken = sessionResponseSchema.parse(json).access_token;
      } catch (error) {
        if (error instanceof GoTrueError) throw unauthenticated('Invalid or expired code');
        throw error;
      }
      try {
        await call('/user', { method: 'PUT', body: { password: newPassword }, accessToken });
      } catch (error) {
        if (error instanceof GoTrueError) {
          throw badRequest(
            error.code === 'same_password'
              ? 'Choose a password you have not used before'
              : 'Choose a stronger password',
          );
        }
        throw error;
      }
      // A reset should evict anyone who had the old password.
      await this.signOut(accessToken, 'global');
    },
  };
}

class GoTrueError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Supabase Auth error ${status} ${code}`);
    this.name = 'GoTrueError';
  }
}
