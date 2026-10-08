import {
  buildIceServers,
  type IceConfigOptions,
  type Logger,
  type Services,
  type SessionActor,
} from '@remote-desktop/backend';
import type { SessionRecord } from '@remote-desktop/shared';
import type { ClientMessage, ClientMessageOf, ServerMessage } from '@remote-desktop/webrtc';
import { send, type Connection, type ConnectionRegistry } from './registry';

export interface HandlerContext {
  services: Services;
  registry: ConnectionRegistry;
  logger: Logger;
  ice: IceConfigOptions;
}

type AuthedConnection = Connection & { userId: string };

function actor(connection: AuthedConnection): SessionActor {
  return { userId: connection.userId, deviceId: connection.deviceId };
}

function ack(connection: Connection, id: string, payload: Record<string, unknown> = {}): void {
  send(connection, { type: 'ack', id, payload });
}

/** Delivers to the controller: its device socket if the session recorded one, else the user's sockets. */
export function toController(
  ctx: Pick<HandlerContext, 'registry'>,
  session: Pick<SessionRecord, 'controllerDeviceId' | 'controllerUserId'>,
  message: ServerMessage,
): void {
  if (
    session.controllerDeviceId &&
    ctx.registry.sendToDevice(session.controllerDeviceId, message)
  ) {
    return;
  }
  ctx.registry.sendToUser(session.controllerUserId, message);
}

export function toTarget(
  ctx: Pick<HandlerContext, 'registry'>,
  session: Pick<SessionRecord, 'targetDeviceId'>,
  message: ServerMessage,
): void {
  ctx.registry.sendToDevice(session.targetDeviceId, message);
}

/**
 * Sends each participant its own ICE configuration. TURN credentials are
 * per user and expire, and are only ever issued for an authorized session.
 */
function sendIceConfig(ctx: HandlerContext, session: SessionRecord): void {
  const controllerConfig = buildIceServers(ctx.ice, session.controllerUserId);
  toController(ctx, session, {
    type: 'session.ice_config',
    payload: { sessionId: session.id, ...controllerConfig },
  });
  const host = ctx.registry.device(session.targetDeviceId);
  if (host?.userId) {
    send(host, {
      type: 'session.ice_config',
      payload: { sessionId: session.id, ...buildIceServers(ctx.ice, host.userId) },
    });
  }
}

/**
 * Message handlers. Every handler derives identity from the authenticated
 * connection and lets the services re-check the database: a `sessionId` or
 * `requestId` in a message is only a pointer, never proof of anything.
 */
export async function handleMessage(
  ctx: HandlerContext,
  connection: AuthedConnection,
  message: Exclude<ClientMessage, { type: 'auth' }>,
): Promise<void> {
  const meta = { ip: connection.ip };
  switch (message.type) {
    case 'connection.request':
      return handleRequest(ctx, connection, message);

    case 'connection.approve': {
      const { request, session } = await ctx.services.connections.approve(
        actor(connection),
        message.payload.requestId,
        message.payload.permissions,
        meta,
      );
      sendIceConfig(ctx, session);
      ack(connection, message.id, {
        sessionId: session.id,
        state: session.state,
        permissions: session.permissions,
      });
      toController(ctx, session, {
        type: 'connection.approve',
        payload: { requestId: request.id, sessionId: session.id, permissions: session.permissions },
      });
      return;
    }

    case 'connection.reject': {
      const { request, session } = await ctx.services.connections.reject(
        actor(connection),
        message.payload.requestId,
        message.payload.reason ?? null,
        meta,
      );
      ack(connection, message.id, { sessionId: session.id, state: session.state });
      toController(ctx, session, {
        type: 'connection.reject',
        payload: {
          requestId: request.id,
          sessionId: session.id,
          reason: message.payload.reason ?? null,
        },
      });
      return;
    }

    case 'webrtc.offer':
    case 'webrtc.answer':
    case 'webrtc.ice_candidate': {
      const kind =
        message.type === 'webrtc.offer'
          ? 'offer'
          : message.type === 'webrtc.answer'
            ? 'answer'
            : 'ice_candidate';
      const { session, side } = await ctx.services.sessions.authorizeRelay(
        actor(connection),
        message.payload.sessionId,
        kind,
      );
      // Rebuild the frame from validated fields only; nothing else is forwarded.
      const relayed: ServerMessage =
        message.type === 'webrtc.ice_candidate'
          ? {
              type: message.type,
              payload: { sessionId: session.id, candidate: message.payload.candidate },
            }
          : { type: message.type, payload: { sessionId: session.id, sdp: message.payload.sdp } };
      if (side === 'controller') toTarget(ctx, session, relayed);
      else toController(ctx, session, relayed);
      ack(connection, message.id, { state: session.state });
      return;
    }

    case 'session.permission_update': {
      const session = await ctx.services.sessions.updatePermissions(
        actor(connection),
        message.payload.sessionId,
        message.payload.permissions,
        meta,
      );
      ack(connection, message.id, { permissions: session.permissions });
      toController(ctx, session, {
        type: 'session.permission_update',
        payload: { sessionId: session.id, permissions: session.permissions },
      });
      return;
    }

    case 'session.end': {
      const { session, endedBy } = await ctx.services.sessions.end(
        actor(connection),
        message.payload.sessionId,
        message.payload.reason ?? null,
        meta,
      );
      ack(connection, message.id, { state: session.state });
      const notice: ServerMessage = {
        type: 'session.end',
        payload: {
          sessionId: session.id,
          state: session.state,
          reason: message.payload.reason ?? null,
        },
      };
      if (endedBy === 'controller') toTarget(ctx, session, notice);
      else toController(ctx, session, notice);
      return;
    }

    case 'session.verify': {
      const { session, side, ended } = await ctx.services.sessions.verify(
        actor(connection),
        message.payload.sessionId,
        meta,
      );
      // A verify is also when long sessions pick up fresh TURN credentials.
      const ice = ended ? null : buildIceServers(ctx.ice, connection.userId);
      ack(connection, message.id, {
        state: session.state,
        ended,
        permissions: session.permissions,
        iceServers: ice?.iceServers ?? [],
        iceExpiresAt: ice?.expiresAt ?? null,
      });
      const other: ServerMessage = ended
        ? {
            type: 'session.end',
            payload: { sessionId: session.id, state: session.state, reason: session.failureReason },
          }
        : {
            type: 'session.permission_update',
            payload: { sessionId: session.id, permissions: session.permissions },
          };
      if (side === 'target') toController(ctx, session, other);
      else toTarget(ctx, session, other);
      return;
    }

    case 'session.report': {
      const session = await ctx.services.sessions.reportState(
        actor(connection),
        message.payload.sessionId,
        { state: message.payload.state, reason: message.payload.reason },
        meta,
      );
      ack(connection, message.id, { state: session.state });
      if (session.state === 'FAILED') {
        toTarget(ctx, session, {
          type: 'session.end',
          payload: { sessionId: session.id, state: session.state, reason: session.failureReason },
        });
      }
      return;
    }

    case 'session.audit': {
      const { sessionId, ...event } = message.payload;
      await ctx.services.sessions.recordPeerAudit(actor(connection), sessionId, event, meta);
      ack(connection, message.id);
      return;
    }
  }
}

async function handleRequest(
  ctx: HandlerContext,
  connection: AuthedConnection,
  message: ClientMessageOf<'connection.request'>,
): Promise<void> {
  const created = await ctx.services.connections.create(
    actor(connection),
    {
      targetDeviceCode: message.payload.targetDeviceCode,
      permissions: message.payload.permissions,
      message: message.payload.message,
      accessPassword: message.payload.accessPassword,
    },
    { ip: connection.ip },
  );
  const { request, session } = created;
  const controller = {
    userId: connection.userId,
    displayName: created.controllerDisplayName,
    deviceCode: connection.deviceCode,
  };
  if (created.autoApproved) sendIceConfig(ctx, session);
  const delivered = created.autoApproved
    ? ctx.registry.sendToDevice(request.targetDeviceId, {
        type: 'connection.approve',
        // The remote side still learns who is connecting: its session
        // indicator must always show the connected user.
        payload: {
          requestId: request.id,
          sessionId: session.id,
          permissions: session.permissions,
          controller,
        },
      })
    : ctx.registry.sendToDevice(request.targetDeviceId, {
        type: 'connection.request',
        payload: {
          requestId: request.id,
          sessionId: session.id,
          controller,
          permissions: request.requestedPermissions,
          message: request.message,
          expiresAt: request.expiresAt,
        },
      });
  ack(connection, message.id, {
    requestId: request.id,
    sessionId: session.id,
    state: session.state,
    autoApproved: created.autoApproved,
    targetOnline: delivered,
    expiresAt: request.expiresAt,
    permissions: created.autoApproved ? session.permissions : request.requestedPermissions,
  });
}
