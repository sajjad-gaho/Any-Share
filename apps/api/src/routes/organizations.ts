import {
  memberAddInputSchema,
  memberUpdateInputSchema,
  organizationCreateInputSchema,
} from '@remote-desktop/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../app';
import { caller, noContent, parse } from '../http';

const orgParams = z.object({ id: z.uuid() });
const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });

export const organizationRoutes =
  (ctx: RouteContext): FastifyPluginAsync =>
  async (app) => {
    const { organizations } = ctx.services;
    app.addHook('preHandler', ctx.requireAuth);

    app.get('/', async (request) => organizations.listForUser(caller(request).userId));

    app.post('/', { config: ctx.limit(10) }, async (request, reply) => {
      const input = parse(organizationCreateInputSchema, request.body);
      return reply.code(201).send(await organizations.create(caller(request).userId, input));
    });

    app.get('/:id', async (request) => {
      const { id } = parse(orgParams, request.params);
      return organizations.get(caller(request).userId, id);
    });

    app.get('/:id/members', async (request) => {
      const { id } = parse(orgParams, request.params);
      return organizations.listMembers(caller(request).userId, id);
    });

    app.post('/:id/members', { config: ctx.limit(30) }, async (request, reply) => {
      const { id } = parse(orgParams, request.params);
      const input = parse(memberAddInputSchema, request.body);
      return reply.code(201).send(await organizations.addMember(caller(request).userId, id, input));
    });

    app.patch('/:id/members/:userId', async (request) => {
      const { id, userId } = parse(memberParams, request.params);
      const { role } = parse(memberUpdateInputSchema, request.body);
      return organizations.updateMemberRole(caller(request).userId, id, userId, role);
    });

    app.delete('/:id/members/:userId', async (request, reply) => {
      const { id, userId } = parse(memberParams, request.params);
      await organizations.removeMember(caller(request).userId, id, userId);
      return noContent(reply);
    });
  };
