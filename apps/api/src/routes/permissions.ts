import { devicePermissionInputSchema } from '@remote-desktop/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../app';
import { caller, noContent, parse, requestMeta } from '../http';

const deviceParams = z.object({ id: z.uuid() });
const grantParams = z.object({ id: z.uuid(), userId: z.uuid() });
const grantBody = devicePermissionInputSchema.omit({ userId: true });

/** Per-user permission ceilings on a device (`device_permissions`). Managers only. */
export const permissionRoutes =
  (ctx: RouteContext): FastifyPluginAsync =>
  async (app) => {
    const { permissions } = ctx.services;
    app.addHook('preHandler', ctx.requireAuth);

    app.get('/:id/permissions', async (request) => {
      const { id } = parse(deviceParams, request.params);
      return permissions.listDevicePermissions(caller(request).userId, id);
    });

    app.put('/:id/permissions/:userId', { config: ctx.limit(30) }, async (request) => {
      const { id, userId } = parse(grantParams, request.params);
      const body = parse(grantBody, request.body);
      return permissions.setDevicePermission(
        caller(request).userId,
        id,
        { userId, permissions: body.permissions, requireApproval: body.requireApproval },
        requestMeta(request),
      );
    });

    app.delete('/:id/permissions/:userId', { config: ctx.limit(30) }, async (request, reply) => {
      const { id, userId } = parse(grantParams, request.params);
      await permissions.removeDevicePermission(
        caller(request).userId,
        id,
        userId,
        requestMeta(request),
      );
      return noContent(reply);
    });
  };
