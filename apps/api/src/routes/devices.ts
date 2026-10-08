import { deviceRegistrationInputSchema, deviceUpdateInputSchema } from '@remote-desktop/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../app';
import { caller, noContent, parse, requestMeta } from '../http';

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({ organizationId: z.uuid().optional() });

export const deviceRoutes =
  (ctx: RouteContext): FastifyPluginAsync =>
  async (app) => {
    const { devices, permissions } = ctx.services;
    app.addHook('preHandler', ctx.requireAuth);

    /** Device lookups are throttled per user so IDs cannot be enumerated quickly. */
    const lookupLimit = (request: FastifyRequest) =>
      ctx.limiters.deviceLookup.consumeOrThrow(`user:${caller(request).userId}`);

    app.get('/', async (request) => {
      const query = parse(listQuery, request.query);
      return devices.list(caller(request).userId, query);
    });

    app.get('/:id', async (request) => {
      lookupLimit(request);
      const { id } = parse(idParams, request.params);
      return devices.get(caller(request).userId, id);
    });

    /** The caller's effective access to a device, as the server computes it. */
    app.get('/:id/access', async (request) => {
      lookupLimit(request);
      const { id } = parse(idParams, request.params);
      return (await permissions.accessFor(caller(request).userId, id)).access;
    });

    app.post('/', { config: ctx.limit(10) }, async (request, reply) => {
      const { userId } = caller(request);
      ctx.limiters.deviceRegistration.consumeOrThrow(`user:${userId}`);
      const input = parse(deviceRegistrationInputSchema, request.body);
      return reply.code(201).send(await devices.register(userId, input, requestMeta(request)));
    });

    app.patch('/:id', { config: ctx.limit(30) }, async (request) => {
      const { id } = parse(idParams, request.params);
      const input = parse(deviceUpdateInputSchema, request.body);
      return devices.update(caller(request).userId, id, input, requestMeta(request));
    });

    /** Revokes the device (soft delete, kept for the audit trail). */
    app.delete('/:id', { config: ctx.limit(30) }, async (request, reply) => {
      const { id } = parse(idParams, request.params);
      await devices.revoke(caller(request).userId, id, requestMeta(request));
      return noContent(reply);
    });
  };
