import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../app';
import { caller, parse } from '../http';

const listQuery = z.object({
  organizationId: z.uuid().optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Audit entries the caller may see under RLS (own actions; organisation's if admin). */
export const auditRoutes =
  (ctx: RouteContext): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', ctx.requireAuth);

    app.get('/', async (request) => {
      const query = parse(listQuery, request.query);
      return ctx.services.audit.list(caller(request).userId, query);
    });
  };
