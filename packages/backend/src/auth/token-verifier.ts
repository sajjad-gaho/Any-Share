import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { unauthenticated } from '../errors';

export interface VerifiedToken {
  userId: string;
  email: string | null;
  /** Supabase Auth session the token belongs to (claim `session_id`). */
  sessionId: string | null;
  /** Unix seconds. Long-lived connections (WebSocket) must end by then. */
  expiresAt: number;
}

export interface TokenVerifier {
  verify(accessToken: string): Promise<VerifiedToken>;
}

const claimsSchema = z.object({
  sub: z.uuid(),
  role: z.literal('authenticated'),
  email: z.string().optional(),
  session_id: z.uuid().optional(),
  exp: z.number(),
});

export interface SupabaseTokenVerifierOptions {
  issuer: string;
  audience: string;
  /** Legacy projects: shared HS256 secret. */
  jwtSecret?: string;
  /** Asymmetric signing keys (default for new projects). */
  jwksUrl?: string;
}

/**
 * Verifies Supabase Auth access tokens locally: signature, issuer, audience,
 * expiry and the `authenticated` role. The user id is taken from the verified
 * `sub` claim only — never from a request body, header or socket message.
 */
export function createSupabaseTokenVerifier(options: SupabaseTokenVerifierOptions): TokenVerifier {
  const secret = options.jwtSecret ? new TextEncoder().encode(options.jwtSecret) : undefined;
  const jwks =
    !secret && options.jwksUrl ? createRemoteJWKSet(new URL(options.jwksUrl)) : undefined;
  if (!secret && !jwks) throw new Error('Token verifier needs a JWT secret or a JWKS URL');

  return {
    async verify(accessToken) {
      let payload: JWTPayload;
      try {
        const verifyOptions = {
          issuer: options.issuer,
          audience: options.audience,
          clockTolerance: 5,
        };
        payload = secret
          ? (await jwtVerify(accessToken, secret, { ...verifyOptions, algorithms: ['HS256'] }))
              .payload
          : (
              await jwtVerify(accessToken, jwks as ReturnType<typeof createRemoteJWKSet>, {
                ...verifyOptions,
                algorithms: ['ES256', 'RS256', 'EdDSA'],
              })
            ).payload;
      } catch (error) {
        if (error instanceof joseErrors.JWTExpired) throw unauthenticated('Session expired');
        throw unauthenticated('Invalid access token');
      }
      const claims = claimsSchema.safeParse(payload);
      if (!claims.success) throw unauthenticated('Invalid access token');
      return {
        userId: claims.data.sub,
        email: claims.data.email ?? null,
        sessionId: claims.data.session_id ?? null,
        expiresAt: claims.data.exp,
      };
    },
  };
}
