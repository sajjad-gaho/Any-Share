import { sessionStateReportSchema } from '@remote-desktop/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../app';
import { caller, parse, requestMeta } from '../http';

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const endBody = z.object({ reason: z.string().trim().max(200).optional() }).strict();

/**
 * Session history and lifecycle over HTTP. Approval and WebRTC negotiation
 * happen on the signaling service; REST callers have no device identity, so
 * they act as `deviceId: null` participants.
 */
export const sessionRoutes =
  (ctx: RouteContext): FastifyPluginAsync =>
  async (app) => {
    const { sessions } = ctx.services;
    app.addHook('preHandler', ctx.requireAuth);

    app.get('/', async (request) => {
      const { limit } = parse(listQuery, request.query);
      return sessions.list(caller(request).userId, { limit });
    });

    app.get('/:id', async (request) => {
      const { id } = parse(idParams, request.params);
      return sessions.get(caller(request).userId, id);
    });

    app.post('/:id/state', { config: ctx.limit(60) }, async (request) => {
      const { id } = parse(idParams, request.params);
      const input = parse(sessionStateReportSchema, request.body);
      return sessions.reportState(
        { userId: caller(request).userId, deviceId: null },
        id,
        input,
        requestMeta(request),
      );
    });

    app.post('/:id/end', { config: ctx.limit(60) }, async (request) => {
      const { id } = parse(idParams, request.params);
      const { reason } = parse(endBody, request.body);
      const { session } = await sessions.end(
        { userId: caller(request).userId, deviceId: null },
        id,
        reason ?? null,
        requestMeta(request),
      );
      return session;
    });
  };
