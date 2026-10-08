import type { FastifyPluginAsync } from 'fastify';
import type { RouteContext } from '../app';

export const healthRoutes =
  (ctx: RouteContext): FastifyPluginAsync =>
  async (app) => {
    /** Liveness: the process is up. No dependencies, no data. */
    app.get('/health', async () => ({ status: 'ok' }));

    /** Readiness: the database answers. Reports nothing about its configuration. */
    app.get('/health/ready', async (_request, reply) => {
      try {
        await ctx.db.query('select 1');
        return { status: 'ready' };
      } catch (error) {
        ctx.logger.error({ err: error }, 'Readiness check failed');
        return reply.code(503).send({ status: 'unavailable' });
      }
    });
  };
