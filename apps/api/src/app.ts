import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  AppError,
  unauthenticated,
  type Db,
  type Limiters,
  type Logger,
  type Services,
} from '@remote-desktop/backend';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type preHandlerAsyncHookHandler,
} from 'fastify';
import { bearerToken } from './http';
import { auditRoutes } from './routes/audit';
import { authRoutes } from './routes/auth';
import { connectionRequestRoutes } from './routes/connection-requests';
import { deviceRoutes } from './routes/devices';
import { healthRoutes } from './routes/health';
import { organizationRoutes } from './routes/organizations';
import { permissionRoutes } from './routes/permissions';
import { sessionRoutes } from './routes/sessions';
import { userRoutes } from './routes/users';

export interface AppDeps {
  services: Services;
  limiters: Limiters;
  db: Db;
  logger: Logger;
  /** Trusted reverse-proxy hops in front of the API (0 = none, Caddy = 1). */
  trustProxy: number;
  /** Scales the per-IP HTTP budgets (looser in development). */
  rateLimitMultiplier: number;
}

export interface RouteContext extends AppDeps {
  requireAuth: preHandlerAsyncHookHandler;
  /** Per-IP budget for a route, scaled by the environment multiplier. */
  limit(max: number, timeWindow?: string): { rateLimit: { max: number; timeWindow: string } };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    // A hop count (not `true`): the client IP is read that many entries from the
    // right of X-Forwarded-For, so a client-supplied header cannot spoof it.
    // (A trust function: Fastify 5's numeric form did not resolve hops as expected.)
    trustProxy:
      deps.trustProxy > 0 ? (_address: string, hop: number) => hop < deps.trustProxy : false,
    bodyLimit: 64 * 1024,
    // Request logs carry method, URL and status only — never bodies (they hold
    // passwords); pino redaction covers headers. Client-supplied request ids are ignored.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    // Slow or stalled clients cannot hold connections open indefinitely.
    connectionTimeout: 30_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 65_000,
  });

  app.decorateRequest('auth', null);

  // Every response is API data for one user: never cache, never sniff, never frame.
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('x-frame-options', 'DENY');
    reply.header('cross-origin-resource-policy', 'same-origin');
    return payload;
  });

  await app.register(rateLimit, {
    global: true,
    max: Math.round(300 * deps.rateLimitMultiplier),
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) =>
      new AppError('rate_limited', 'Too many requests. Try again later.', {
        retryAfterSeconds: Math.ceil(context.ttl / 1000),
      }),
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.details?.retryAfterSeconds) {
        void reply.header('retry-after', String(error.details.retryAfterSeconds));
      }
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Fastify's own client errors: malformed JSON, oversized body, bad content type.
      return reply.code(status).send({
        error: {
          code: status === 413 ? 'payload_too_large' : 'bad_request',
          message: 'Malformed request',
        },
      });
    }
    request.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } }),
  );

  const requireAuth: preHandlerAsyncHookHandler = async (request) => {
    const token = bearerToken(request);
    if (!token) throw unauthenticated();
    request.auth = await deps.services.auth.authenticate(token);
  };

  const context: RouteContext = {
    ...deps,
    requireAuth,
    limit: (max, timeWindow = '1 minute') => ({
      rateLimit: { max: Math.max(1, Math.round(max * deps.rateLimitMultiplier)), timeWindow },
    }),
  };

  await app.register(healthRoutes(context));
  await app.register(
    async (v1) => {
      // Same probes under the versioned prefix (what the reverse proxy exposes).
      await v1.register(healthRoutes(context));
      await v1.register(authRoutes(context), { prefix: '/auth' });
      await v1.register(userRoutes(context), { prefix: '/users' });
      await v1.register(organizationRoutes(context), { prefix: '/organizations' });
      await v1.register(deviceRoutes(context), { prefix: '/devices' });
      await v1.register(permissionRoutes(context), { prefix: '/devices' });
      await v1.register(sessionRoutes(context), { prefix: '/sessions' });
      await v1.register(connectionRequestRoutes(context), { prefix: '/connection-requests' });
      await v1.register(auditRoutes(context), { prefix: '/audit-logs' });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
