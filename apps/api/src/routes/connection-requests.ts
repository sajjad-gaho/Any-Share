import { connectionRequestStatusSchema } from '@remote-desktop/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../app';
import { caller, parse } from '../http';

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({
  direction: z.enum(['incoming', 'outgoing']).default('outgoing'),
  status: connectionRequestStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Read and cancel over HTTP. Creating, approving and rejecting requests is done
 * on the signaling service, which pushes them to the remote device in real
 * time and requires the remote's device-key proof to approve.
 */
export const connectionRequestRoutes =
  (ctx: RouteContext): FastifyPluginAsync =>
  async (app) => {
    const { connections } = ctx.services;
    app.addHook('preHandler', ctx.requireAuth);

    app.get('/', async (request) => {
      const query = parse(listQuery, request.query);
      return connections.list(caller(request).userId, query);
    });

    app.get('/:id', async (request) => {
      const { id } = parse(idParams, request.params);
      return connections.get(caller(request).userId, id);
    });

    app.post('/:id/cancel', { config: ctx.limit(30) }, async (request) => {
      const { id } = parse(idParams, request.params);
      return connections.cancel(caller(request).userId, id);
    });
  };
