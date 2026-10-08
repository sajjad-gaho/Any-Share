import { profileInputSchema } from '@remote-desktop/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { RouteContext } from '../app';
import { caller, parse } from '../http';

export const userRoutes =
  (ctx: RouteContext): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', ctx.requireAuth);

    app.get('/me', async (request) => {
      const { userId, email } = caller(request);
      return ctx.services.users.getMe(userId, email);
    });

    app.patch('/me', async (request) => {
      const { userId, email } = caller(request);
      const input = parse(profileInputSchema, request.body);
      return ctx.services.users.updateProfile(userId, input, email);
    });
  };
