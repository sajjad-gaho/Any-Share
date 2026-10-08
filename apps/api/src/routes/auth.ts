import {
  loginInputSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  refreshInputSchema,
  registerInputSchema,
} from '@remote-desktop/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { RouteContext } from '../app';
import { caller, noContent, parse, requestMeta } from '../http';

/**
 * Supabase Auth behind our API, so every auth action is rate-limited,
 * brute-force protected and audited in one place. Responses carry tokens only
 * to the caller; tokens are never logged (pino redaction) or audited.
 */
export const authRoutes =
  (ctx: RouteContext): FastifyPluginAsync =>
  async (app) => {
    const { auth } = ctx.services;

    app.post('/register', { config: ctx.limit(5) }, async (request, reply) => {
      const input = parse(registerInputSchema, request.body);
      const result = await auth.register(input);
      return reply.code(201).send(result);
    });

    app.post('/login', { config: ctx.limit(10) }, async (request) => {
      const input = parse(loginInputSchema, request.body);
      return auth.login(input, requestMeta(request));
    });

    /** Session restoration: exchanges a refresh token (rotated by Supabase) for new tokens. */
    app.post('/refresh', { config: ctx.limit(30) }, async (request) => {
      const { refreshToken } = parse(refreshInputSchema, request.body);
      return auth.refresh(refreshToken);
    });

    app.post(
      '/logout',
      { preHandler: ctx.requireAuth, config: ctx.limit(30) },
      async (request, reply) => {
        await auth.logout(caller(request), requestMeta(request));
        return noContent(reply);
      },
    );

    /** Always 202, whether or not the address has an account. */
    app.post('/password-reset', { config: ctx.limit(5) }, async (request, reply) => {
      const { email } = parse(passwordResetRequestSchema, request.body);
      await auth.requestPasswordReset(email);
      return reply.code(202).send({ status: 'sent_if_registered' });
    });

    app.post('/password-reset/confirm', { config: ctx.limit(5) }, async (request, reply) => {
      const input = parse(passwordResetConfirmSchema, request.body);
      await auth.confirmPasswordReset(input, requestMeta(request));
      return noContent(reply);
    });
  };
