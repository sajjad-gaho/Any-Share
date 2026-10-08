import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AppError,
  verifyDeviceSignature,
  type IceConfigOptions,
  type Limiters,
  type Logger,
  type Services,
} from '@remote-desktop/backend';
import {
  MAX_SIGNALING_FRAME_BYTES,
  SIGNALING_CLOSE_CODES,
  SIGNALING_PROTOCOL_VERSION,
  deviceAuthMessage,
  parseClientMessage,
  type ClientMessageOf,
  type ServerMessage,
} from '@remote-desktop/webrtc';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { handleMessage, toController, toTarget, type HandlerContext } from './handlers';
import { ConnectionRegistry, send, type Connection } from './registry';

export interface SignalingOptions {
  services: Services;
  limiters: Limiters;
  logger: Logger;
  /** Ping interval; a socket that misses one pong is terminated. */
  heartbeatIntervalMs: number;
  /** How often last_seen_at is written for connected devices (one batched UPDATE). */
  presenceFlushIntervalMs: number;
  /** How long a new socket has to complete `auth`. */
  authTimeoutMs?: number;
  /** How often pending connection requests are checked for expiry. */
  expirySweepIntervalMs?: number;
  /** Trusted reverse-proxy hops in front of signaling (0 = none, Caddy = 1). */
  trustProxy?: number;
  /** How often authenticated sockets re-check that their sign-in is still valid. */
  authRecheckIntervalMs?: number;
  /** Readiness probe for `/health/ready` (e.g. a `select 1`); omitted = always ready. */
  readinessCheck?: () => Promise<void>;
  /** Close a connection after this many invalid frames. */
  maxProtocolErrors?: number;
  /** STUN/TURN configuration handed to authorized session participants. */
  ice?: IceConfigOptions;
  /** Approved sessions must reach CONNECTED within this many seconds. */
  sessionConnectTimeoutSeconds?: number;
  /** A participant may be gone from signaling this long before its sessions fail. */
  peerDisconnectGraceMs?: number;
  /**
   * After start-up, end live sessions whose participants did not reconnect.
   * Enable for the single production instance; off by default because several
   * instances sharing one database (tests) would end each other's sessions.
   */
  reconcileOnStart?: boolean;
}

export interface SignalingServer {
  httpServer: Server;
  registry: ConnectionRegistry;
  listen(port: number, host: string): Promise<AddressInfo>;
  /** Runs one presence flush now (tests, shutdown). */
  flushPresence(): Promise<void>;
  /** Runs one expiry sweep now (tests). */
  sweepExpired(): Promise<void>;
  /** Re-checks every socket's sign-in now (tests). */
  recheckAuth(): Promise<void>;
  close(): Promise<void>;
}

const WS_PATH = '/ws';

/**
 * Client address. With `trustedHops` proxies in front, the address is read
 * that many entries from the *right* of X-Forwarded-For (each trusted proxy
 * appends the address it saw), so a client-supplied header cannot spoof it.
 */
export function clientIp(request: IncomingMessage, trustedHops: number): string {
  const socketAddress = request.socket.remoteAddress ?? 'unknown';
  if (trustedHops <= 0) return socketAddress;
  const header = request.headers['x-forwarded-for'];
  const chain = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return chain[chain.length - trustedHops] ?? socketAddress;
}

function sendError(connection: Connection, id: string | null, code: string, message: string): void {
  send(connection, { type: 'error', id, payload: { code, message } });
}

export function createSignalingServer(options: SignalingOptions): SignalingServer {
  const { services, limiters, logger } = options;
  const registry = new ConnectionRegistry();
  const ctx: HandlerContext = {
    services,
    registry,
    logger,
    ice: options.ice ?? { stunUrls: [], turnUrls: [], turnSecret: undefined, ttlSeconds: 3600 },
  };
  const disconnectGraceMs = options.peerDisconnectGraceMs ?? 30_000;
  /** Pending "participant vanished" timers, keyed `device:<id>` / `user:<id>`. */
  const disconnectTimers = new Map<string, NodeJS.Timeout>();
  /** Set during shutdown: sockets closing because *we* stop must not end sessions. */
  let closing = false;
  const maxProtocolErrors = options.maxProtocolErrors ?? 10;
  /** Devices that answered a heartbeat since the last presence flush. */
  const seenDevices = new Set<string>();

  const httpServer = createServer((request, response) => {
    const json = { 'content-type': 'application/json', 'cache-control': 'no-store' };
    // Probes report status only: no connection counts or other internals.
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, json);
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/health/ready') {
      void (options.readinessCheck?.() ?? Promise.resolve()).then(
        () => {
          response.writeHead(200, json);
          response.end(JSON.stringify({ status: 'ready' }));
        },
        (error: unknown) => {
          logger.error({ err: error }, 'Readiness check failed');
          response.writeHead(503, json);
          response.end(JSON.stringify({ status: 'unavailable' }));
        },
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'not_found' } }));
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_SIGNALING_FRAME_BYTES,
    perMessageDeflate: false,
  });

  httpServer.on('upgrade', (request, socket, head) => {
    const path = (request.url ?? '').split('?')[0];
    if (path !== WS_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const ip = clientIp(request, options.trustProxy ?? 0);
    // Throttle connection attempts per IP before doing any work.
    if (!limiters.wsAuthByIp.consume(`ip:${ip}`).allowed) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => onConnection(ws, ip));
  });

  function onConnection(socket: WebSocket, ip: string): void {
    const connection: Connection = {
      id: randomUUID(),
      socket,
      ip,
      nonce: randomBytes(32).toString('base64url'),
      userId: null,
      deviceId: null,
      deviceCode: null,
      tokenExpiresAt: 0,
      alive: true,
      protocolErrors: 0,
      timers: [],
    };
    registry.all.add(connection);

    connection.timers.push(
      setTimeout(() => {
        if (!connection.userId) {
          socket.close(SIGNALING_CLOSE_CODES.authTimeout, 'Authentication timeout');
        }
      }, options.authTimeoutMs ?? 10_000),
    );

    socket.on('pong', () => {
      connection.alive = true;
      if (connection.deviceId) seenDevices.add(connection.deviceId);
    });
    socket.on('message', (data, isBinary) => void onMessage(connection, data, isBinary));
    socket.on('close', () => void onClose(connection));
    socket.on('error', (error) =>
      logger.debug({ err: error, connectionId: connection.id }, 'Socket error'),
    );

    send(connection, {
      type: 'auth.challenge',
      payload: { nonce: connection.nonce ?? '', protocolVersion: SIGNALING_PROTOCOL_VERSION },
    });
  }

  function protocolError(connection: Connection, id: string | null, message: string): void {
    connection.protocolErrors += 1;
    sendError(connection, id, 'invalid_message', message);
    if (connection.protocolErrors >= maxProtocolErrors) {
      connection.socket.close(SIGNALING_CLOSE_CODES.protocolError, 'Too many invalid messages');
    }
  }

  async function onMessage(
    connection: Connection,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) {
      protocolError(connection, null, 'Binary frames are not accepted');
      return;
    }
    if (!limiters.wsMessagesPerConnection.consume(`conn:${connection.id}`).allowed) {
      sendError(connection, null, 'rate_limited', 'Too many messages');
      connection.socket.close(SIGNALING_CLOSE_CODES.rateLimited, 'Rate limited');
      return;
    }
    const parsed = parseClientMessage(data.toString());
    if (!parsed.ok) {
      protocolError(connection, parsed.id, parsed.error);
      return;
    }
    const message = parsed.message;

    if (message.type === 'auth') {
      await authenticate(connection, message);
      return;
    }
    if (!connection.userId) {
      sendError(connection, message.id, 'unauthenticated', 'Authenticate first');
      connection.socket.close(SIGNALING_CLOSE_CODES.authFailed, 'Unauthenticated');
      return;
    }
    if (connection.tokenExpiresAt * 1000 <= Date.now()) {
      sendError(connection, message.id, 'unauthenticated', 'Session expired');
      connection.socket.close(SIGNALING_CLOSE_CODES.authFailed, 'Token expired');
      return;
    }
    try {
      await handleMessage(ctx, connection as Connection & { userId: string }, message);
    } catch (error) {
      if (error instanceof AppError) {
        sendError(connection, message.id, error.code, error.message);
      } else {
        logger.error({ err: error, type: message.type }, 'Signaling handler failed');
        sendError(connection, message.id, 'internal', 'Internal error');
      }
    }
  }

  async function authenticate(
    connection: Connection,
    message: ClientMessageOf<'auth'>,
  ): Promise<void> {
    const fail = (reason: string) => {
      // Failed attempts count double against the IP's connection budget.
      limiters.wsAuthByIp.consume(`ip:${connection.ip}`, 2);
      sendError(connection, message.id, 'unauthenticated', reason);
      connection.socket.close(SIGNALING_CLOSE_CODES.authFailed, 'Authentication failed');
    };
    if (connection.userId || !connection.nonce) {
      fail('Already authenticated');
      return;
    }
    const nonce = connection.nonce;
    connection.nonce = null; // single use, whatever the outcome

    let userId: string;
    let expiresAt: number;
    let authSessionId: string | null;
    try {
      const auth = await services.auth.authenticate(message.payload.accessToken);
      userId = auth.userId;
      expiresAt = auth.expiresAt;
      authSessionId = auth.sessionId;
    } catch {
      fail('Invalid or expired access token');
      return;
    }

    let deviceId: string | null = null;
    let deviceCode: string | null = null;
    if (message.payload.device) {
      const claimed = message.payload.device.deviceId;
      const publicKey = await services.devices.getPublicKey(claimed);
      const proven =
        publicKey !== null &&
        verifyDeviceSignature(
          publicKey,
          deviceAuthMessage(nonce, claimed),
          message.payload.device.signature,
        );
      const device = proven ? await services.permissions.loadDevice(claimed) : undefined;
      const access = device ? await services.permissions.resolveAccess(userId, device) : undefined;
      if (!device || !access?.canManage) {
        fail('Device identity could not be verified');
        return;
      }
      deviceId = device.id;
      deviceCode = device.device_code;
    }

    connection.userId = userId;
    connection.deviceId = deviceId;
    connection.deviceCode = deviceCode;
    connection.tokenExpiresAt = expiresAt;
    connection.authSessionId = authSessionId;
    const msUntilExpiry = Math.max(0, expiresAt * 1000 - Date.now());
    connection.timers.push(
      setTimeout(
        () => connection.socket.close(SIGNALING_CLOSE_CODES.authFailed, 'Token expired'),
        Math.min(msUntilExpiry, 2 ** 31 - 1),
      ),
    );

    // Back within the grace period: the sessions survive.
    for (const key of [`device:${deviceId ?? ''}`, deviceId ? '' : `user:${userId}`]) {
      const timer = disconnectTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        disconnectTimers.delete(key);
      }
    }
    registry.all.delete(connection); // re-added with identity indexes
    const replaced = registry.add(connection);
    if (replaced) {
      replaced.socket.close(SIGNALING_CLOSE_CODES.replaced, 'Replaced by a newer connection');
    }
    send(connection, { type: 'auth.ok', payload: { userId, deviceId, deviceCode } });
    logger.info(
      { connectionId: connection.id, userId, deviceId },
      'Signaling client authenticated',
    );

    if (deviceId && deviceCode) {
      await services.devices.setOnline(deviceId, true);
      await broadcastPresence(deviceId, {
        type: 'device.online',
        payload: { deviceId, deviceCode },
      });
    }
  }

  async function broadcastPresence(deviceId: string, message: ServerMessage): Promise<void> {
    try {
      for (const userId of await services.devices.presenceAudience(deviceId)) {
        registry.sendToUser(userId, message);
      }
    } catch (error) {
      logger.error({ err: error }, 'Presence broadcast failed');
    }
  }

  /**
   * After a participant has been gone for the grace period, fail the live
   * sessions it was part of and tell the other side, so the remote machine's
   * capture and input never outlive a vanished controller (and vice versa).
   */
  function scheduleDisconnectFailure(connection: Connection): void {
    if (closing || !connection.userId) return;
    const { userId, deviceId } = connection;
    const key = deviceId ? `device:${deviceId}` : `user:${userId}`;
    if (!deviceId && registry.hasDevicelessSocket(userId)) return;
    clearTimeout(disconnectTimers.get(key));
    const timer = setTimeout(() => {
      disconnectTimers.delete(key);
      void (async () => {
        if (deviceId ? registry.device(deviceId) : registry.hasDevicelessSocket(userId)) return;
        try {
          const live = deviceId
            ? await services.sessions.liveSessionsForDevice(deviceId)
            : await services.sessions.liveSessionsForDevicelessController(userId);
          const failed = await services.sessions.failSessions(
            live.map((s) => s.id),
            'peer_disconnected',
          );
          for (const session of failed) {
            const notice: ServerMessage = {
              type: 'session.end',
              payload: { sessionId: session.id, state: session.state, reason: 'peer_disconnected' },
            };
            toController(ctx, session, notice);
            toTarget(ctx, session, notice);
          }
        } catch (error) {
          logger.error({ err: error }, 'Failed to end sessions of a disconnected participant');
        }
      })();
    }, disconnectGraceMs);
    disconnectTimers.set(key, timer);
  }

  async function onClose(connection: Connection): Promise<void> {
    for (const timer of connection.timers) clearTimeout(timer);
    const wasCurrentDeviceSocket = registry.remove(connection);
    if (wasCurrentDeviceSocket || (connection.userId && !connection.deviceId)) {
      scheduleDisconnectFailure(connection);
    }
    if (wasCurrentDeviceSocket && connection.deviceId && connection.deviceCode) {
      const { deviceId, deviceCode } = connection;
      seenDevices.delete(deviceId);
      try {
        await services.devices.setOnline(deviceId, false);
      } catch (error) {
        logger.error({ err: error }, 'Failed to mark device offline');
      }
      await broadcastPresence(deviceId, {
        type: 'device.offline',
        payload: { deviceId, deviceCode, lastSeenAt: new Date().toISOString() },
      });
    }
  }

  // Heartbeat: one ping per interval; a socket that did not pong since the last one is dead.
  const heartbeat = setInterval(() => {
    for (const connection of registry.all) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }, options.heartbeatIntervalMs);

  /**
   * Authentication is not a one-time check: a socket whose Supabase session was
   * signed out (logout, password change, admin revocation) is closed, instead of
   * living on until the access token expires.
   */
  async function recheckAuth(): Promise<void> {
    for (const connection of [...registry.all]) {
      if (!connection.userId) continue;
      try {
        await services.auth.assertStillSignedIn({
          userId: connection.userId,
          sessionId: connection.authSessionId ?? null,
        });
      } catch (error) {
        if (error instanceof AppError && error.code === 'unauthenticated') {
          connection.socket.close(SIGNALING_CLOSE_CODES.authFailed, 'Signed out');
        } else {
          logger.warn({ err: error }, 'Sign-in re-check failed; keeping the connection');
        }
      }
    }
  }
  const authRecheck = setInterval(
    () => void recheckAuth(),
    options.authRecheckIntervalMs ?? 60_000,
  );

  async function flushPresence(): Promise<void> {
    const ids = [...seenDevices];
    seenDevices.clear();
    try {
      await services.devices.touchLastSeen(ids);
      // Close sockets of devices revoked through the API since they connected.
      for (const revoked of await services.devices.findRevoked(registry.connectedDeviceIds())) {
        registry.device(revoked)?.socket.close(SIGNALING_CLOSE_CODES.authFailed, 'Device revoked');
      }
    } catch (error) {
      logger.error({ err: error }, 'Presence flush failed');
    }
  }
  const presenceFlush = setInterval(() => void flushPresence(), options.presenceFlushIntervalMs);

  /**
   * After a restart this instance has no disconnect timers for sessions that
   * were live before. Once the grace period has passed, fail every live
   * session whose participants did not come back, so nothing stays
   * "connected" in the database forever.
   */
  async function reconcileAfterStart(): Promise<void> {
    try {
      const live = await services.sessions.allLiveSessions();
      const orphaned = live.filter((session) => {
        const hostBack = registry.device(session.targetDeviceId) !== undefined;
        const controllerBack = session.controllerDeviceId
          ? registry.device(session.controllerDeviceId) !== undefined
          : registry.hasDevicelessSocket(session.controllerUserId);
        return !hostBack || !controllerBack;
      });
      const failed = await services.sessions.failSessions(
        orphaned.map((s) => s.id),
        'peer_disconnected',
      );
      for (const session of failed) {
        const notice: ServerMessage = {
          type: 'session.end',
          payload: { sessionId: session.id, state: session.state, reason: 'peer_disconnected' },
        };
        toController(ctx, session, notice);
        toTarget(ctx, session, notice);
      }
      if (failed.length > 0)
        logger.info({ count: failed.length }, 'Ended sessions orphaned by a restart');
    } catch (error) {
      logger.error({ err: error }, 'Start-up session reconciliation failed');
    }
  }
  const reconcileTimer = options.reconcileOnStart
    ? setTimeout(() => void reconcileAfterStart(), disconnectGraceMs)
    : undefined;

  async function sweepExpired(): Promise<void> {
    try {
      for (const expired of await services.connections.expireStale()) {
        if (!expired.sessionId) continue;
        const notice: ServerMessage = {
          type: 'session.end',
          payload: { sessionId: expired.sessionId, state: 'EXPIRED', reason: 'expired' },
        };
        registry.sendToUser(expired.controllerUserId, notice);
        registry.sendToDevice(expired.targetDeviceId, notice);
      }
      // Short-lived authorization: approved sessions must connect in time.
      for (const stale of await services.sessions.expireStaleSessions(
        options.sessionConnectTimeoutSeconds ?? 90,
      )) {
        const notice: ServerMessage = {
          type: 'session.end',
          payload: {
            sessionId: stale.sessionId,
            state: stale.state,
            reason: 'authorization_expired',
          },
        };
        registry.sendToUser(stale.controllerUserId, notice);
        registry.sendToDevice(stale.targetDeviceId, notice);
      }
    } catch (error) {
      logger.error({ err: error }, 'Expiry sweep failed');
    }
  }
  const expirySweep = setInterval(
    () => void sweepExpired(),
    options.expirySweepIntervalMs ?? 5_000,
  );

  return {
    httpServer,
    registry,
    flushPresence,
    sweepExpired,
    recheckAuth,
    async listen(port, host) {
      await services.devices.markAllOffline();
      await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
      return httpServer.address() as AddressInfo;
    },
    async close() {
      clearInterval(heartbeat);
      clearInterval(presenceFlush);
      clearInterval(expirySweep);
      clearInterval(authRecheck);
      clearTimeout(reconcileTimer);
      closing = true;
      for (const timer of disconnectTimers.values()) clearTimeout(timer);
      disconnectTimers.clear();
      for (const connection of registry.all) {
        connection.socket.close(SIGNALING_CLOSE_CODES.serverShutdown, 'Server shutting down');
      }
      await flushPresence();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
