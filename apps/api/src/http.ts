import {
  badRequest,
  unauthenticated,
  type AuthContext,
  type RequestMeta,
} from '@remote-desktop/backend';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAuth` from a verified access token. The only source of identity. */
    auth: AuthContext | null;
  }
}

/** Validates untrusted input with a shared Zod schema; failures become 400s. */
export function parse<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw badRequest(`${where}${issue?.message ?? 'Invalid request'}`);
}

export function requestMeta(request: FastifyRequest): RequestMeta {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip || null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 200) : null,
  };
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{16,8192})$/.exec(header);
  return match?.[1] ?? null;
}

/** The authenticated caller; throws 401 when the route ran without `requireAuth`. */
export function caller(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}

export function noContent(reply: FastifyReply): FastifyReply {
  return reply.code(204).send();
}
