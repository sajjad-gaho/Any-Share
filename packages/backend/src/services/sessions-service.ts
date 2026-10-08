import {
  SIGNALING_SESSION_STATES,
  TERMINAL_SESSION_STATES,
  canTransition,
  intersectPermissions,
  normalizePermissions,
  sortPermissions,
  type SessionPermission,
  type SessionRecord,
  type SessionState,
} from '@remote-desktop/shared';
import { asUser, type Queryable } from '../db/types';
import { PG, badRequest, forbidden, invalidState, notFound, pgErrorCode } from '../errors';
import type { AuditService } from './audit-service';
import { toIso, toIsoOrNull, type RequestMeta, type ServiceDeps } from './context';
import type { PermissionsService } from './permissions-service';

interface SessionRow {
  id: string;
  connection_request_id: string | null;
  state: SessionState;
  controller_user_id: string;
  controller_device_id: string | null;
  target_device_id: string;
  target_device_code: string | null;
  target_device_name: string | null;
  organization_id: string | null;
  permissions: SessionPermission[];
  failure_reason: string | null;
  created_at: Date | string;
  connected_at: Date | string | null;
  ended_at: Date | string | null;
}

const SESSION_SELECT = `select s.id, s.connection_request_id, s.state::text as state,
    s.controller_user_id, s.controller_device_id, s.target_device_id,
    d.device_code as target_device_code, d.name as target_device_name, s.organization_id,
    coalesce((select array_agg(sp.permission::text order by sp.permission)
                from public.session_permissions sp where sp.session_id = s.id),
             '{}'::text[]) as permissions,
    s.failure_reason, s.created_at, s.connected_at, s.ended_at
  from public.sessions s
  left join public.devices d on d.id = s.target_device_id`;

export const toSessionRecord = (row: SessionRow): SessionRecord => ({
  id: row.id,
  connectionRequestId: row.connection_request_id,
  state: row.state,
  controllerUserId: row.controller_user_id,
  controllerDeviceId: row.controller_device_id,
  targetDeviceId: row.target_device_id,
  targetDeviceCode: row.target_device_code,
  targetDeviceName: row.target_device_name,
  organizationId: row.organization_id,
  permissions: sortPermissions(row.permissions),
  failureReason: row.failure_reason,
  createdAt: toIso(row.created_at),
  connectedAt: toIsoOrNull(row.connected_at),
  endedAt: toIsoOrNull(row.ended_at),
});

/** Which end of a session the caller is on, decided from database facts. */
export type SessionSide = 'controller' | 'target';

export interface SessionActor {
  userId: string;
  /** Set when the caller is an authenticated device socket; null for REST calls. */
  deviceId: string | null;
}

/** States in which the target may change what the controller is allowed to do. */
const PERMISSION_EDITABLE_STATES: readonly SessionState[] = [
  'AUTHORIZING',
  'SIGNALING',
  'CONNECTING',
  'CONNECTED',
  'RECONNECTING',
];

export class SessionsService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
  ) {}

  async list(userId: string, options: { limit: number }): Promise<SessionRecord[]> {
    const rows = await asUser(this.deps.db, userId, (tx) =>
      tx.query<SessionRow>(`${SESSION_SELECT} order by s.created_at desc limit $1`, [
        options.limit,
      ]),
    );
    return rows.map(toSessionRecord);
  }

  async get(userId: string, sessionId: string): Promise<SessionRecord> {
    const [row] = await asUser(this.deps.db, userId, (tx) =>
      tx.query<SessionRow>(`${SESSION_SELECT} where s.id = $1`, [sessionId]),
    );
    if (!row) throw notFound('Session');
    return toSessionRecord(row);
  }

  async getPrivileged(sessionId: string, tx?: Queryable): Promise<SessionRecord> {
    const [row] = await (tx ?? this.deps.db).query<SessionRow>(
      `${SESSION_SELECT} where s.id = $1`,
      [sessionId],
    );
    if (!row) throw notFound('Session');
    return toSessionRecord(row);
  }

  /**
   * Moves a session to `to`, validating the transition in code first and
   * again in the database trigger. Locks the row so concurrent transitions
   * serialise.
   */
  async transition(
    tx: Queryable,
    sessionId: string,
    to: SessionState,
    reason?: string | null,
  ): Promise<SessionState> {
    const [current] = await tx.query<{ state: SessionState }>(
      'select state::text as state from public.sessions where id = $1 for update',
      [sessionId],
    );
    if (!current) throw notFound('Session');
    if (!canTransition(current.state, to)) {
      throw invalidState(`Session cannot move from ${current.state} to ${to}`);
    }
    try {
      await tx.query(
        `update public.sessions
            set state = $2::public.session_state, failure_reason = coalesce($3, failure_reason)
          where id = $1`,
        [sessionId, to, reason ?? null],
      );
    } catch (error) {
      if (pgErrorCode(error) === PG.checkViolation)
        throw invalidState('Invalid session transition');
      throw error;
    }
    return current.state;
  }

  async replacePermissions(
    tx: Queryable,
    sessionId: string,
    permissions: readonly SessionPermission[],
    grantedBy: string | null,
  ): Promise<void> {
    // Serialise concurrent updates for one session (delete + insert would
    // otherwise race and collide on the unique (session, permission) key).
    await tx.query('select 1 from public.sessions where id = $1 for update', [sessionId]);
    await tx.query('delete from public.session_permissions where session_id = $1', [sessionId]);
    await tx.query(
      `insert into public.session_permissions (session_id, permission, granted_by)
       select $1, p, $3 from unnest($2::public.session_permission[]) as p`,
      [sessionId, sortPermissions(permissions), grantedBy],
    );
  }

  /**
   * Decides which side of `session` the actor is on. A device socket is the
   * target only if it *is* the target device and its user may manage it; it is
   * the controller only if its user started the session (from this device, if
   * one was recorded). Everyone else gets 404.
   */
  async resolveSide(
    actor: SessionActor,
    session: SessionRecord,
    tx?: Queryable,
  ): Promise<SessionSide> {
    const manageTarget = async () => {
      const device = await this.permissions.loadDevice(session.targetDeviceId, tx);
      if (!device) return false;
      const access = await this.permissions.resolveAccess(actor.userId, device, tx);
      return access.canManage;
    };

    if (actor.deviceId !== null && actor.deviceId === session.targetDeviceId) {
      if (await manageTarget()) return 'target';
      throw notFound('Session');
    }
    if (
      actor.userId === session.controllerUserId &&
      (actor.deviceId === null ||
        session.controllerDeviceId === null ||
        actor.deviceId === session.controllerDeviceId)
    ) {
      return 'controller';
    }
    if (actor.deviceId === null && (await manageTarget())) return 'target';
    throw notFound('Session');
  }

  /**
   * Authorises relaying a WebRTC message for `sessionId` and returns where it
   * should go. An offer from the controller advances SIGNALING -> CONNECTING.
   */
  async authorizeRelay(
    actor: SessionActor,
    sessionId: string,
    kind: 'offer' | 'answer' | 'ice_candidate',
  ): Promise<{ session: SessionRecord; side: SessionSide }> {
    return this.deps.db.transaction(async (tx) => {
      const session = await this.getPrivileged(sessionId, tx);
      const side = await this.resolveSide(actor, session, tx);
      if (!SIGNALING_SESSION_STATES.includes(session.state)) {
        throw invalidState(`Session is ${session.state}; signaling is not allowed`);
      }
      if (kind === 'offer' && side !== 'controller')
        throw forbidden('Only the controller sends offers');
      if (kind === 'answer' && side !== 'target') throw forbidden('Only the remote device answers');
      if (kind === 'offer' && session.state === 'SIGNALING') {
        await this.transition(tx, sessionId, 'CONNECTING');
        return { session: { ...session, state: 'CONNECTING' }, side };
      }
      return { session, side };
    });
  }

  /** Connection-progress reports from either participant. */
  async reportState(
    actor: SessionActor,
    sessionId: string,
    input: { state: 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'FAILED'; reason?: string },
    meta: RequestMeta,
  ): Promise<SessionRecord> {
    return this.deps.db.transaction(async (tx) => {
      const session = await this.getPrivileged(sessionId, tx);
      await this.resolveSide(actor, session, tx);
      await this.transition(
        tx,
        sessionId,
        input.state,
        input.state === 'FAILED' ? (input.reason ?? 'failed') : null,
      );
      if (input.state === 'CONNECTED' && session.connectedAt === null) {
        await this.audit.record(
          {
            action: 'SESSION_STARTED',
            actorUserId: actor.userId,
            actorDeviceId: actor.deviceId,
            organizationId: session.organizationId,
            targetType: 'session',
            targetId: sessionId,
            metadata: {
              targetDeviceId: session.targetDeviceId,
              controllerUserId: session.controllerUserId,
              permissions: session.permissions.join(','),
            },
          },
          meta,
          tx,
        );
      }
      if (input.state === 'FAILED') {
        await this.audit.record(
          {
            action: 'SESSION_ENDED',
            actorUserId: actor.userId,
            actorDeviceId: actor.deviceId,
            organizationId: session.organizationId,
            targetType: 'session',
            targetId: sessionId,
            metadata: { outcome: 'failed', reason: input.reason ?? null },
          },
          meta,
          tx,
        );
      }
      return this.getPrivileged(sessionId, tx);
    });
  }

  async end(
    actor: SessionActor,
    sessionId: string,
    reason: string | null,
    meta: RequestMeta,
  ): Promise<{ session: SessionRecord; endedBy: SessionSide }> {
    return this.deps.db.transaction(async (tx) => {
      const session = await this.getPrivileged(sessionId, tx);
      const side = await this.resolveSide(actor, session, tx);
      if (TERMINAL_SESSION_STATES.includes(session.state)) {
        throw invalidState('Session has already ended');
      }
      if (session.state === 'REQUESTING' || session.state === 'APPROVAL_PENDING') {
        if (session.connectionRequestId) {
          await tx.query(
            `update public.connection_requests set status = 'cancelled', responded_by = $2
              where id = $1 and status = 'pending'`,
            [session.connectionRequestId, actor.userId],
          );
        }
        await this.transition(tx, sessionId, 'ENDED', reason ?? 'cancelled');
      } else {
        if (session.state !== 'ENDING') await this.transition(tx, sessionId, 'ENDING');
        await this.transition(tx, sessionId, 'ENDED', reason);
      }
      await this.audit.record(
        {
          action: 'SESSION_ENDED',
          actorUserId: actor.userId,
          actorDeviceId: actor.deviceId,
          organizationId: session.organizationId,
          targetType: 'session',
          targetId: sessionId,
          metadata: { endedBy: side, reason, previousState: session.state },
        },
        meta,
        tx,
      );
      return { session: await this.getPrivileged(sessionId, tx), endedBy: side };
    });
  }

  /**
   * The remote side changes what the controller may do mid-session. The result
   * can never exceed the controller's current ceiling on the device, however
   * the request is phrased.
   */
  async updatePermissions(
    actor: SessionActor,
    sessionId: string,
    requested: readonly SessionPermission[],
    meta: RequestMeta,
  ): Promise<SessionRecord> {
    return this.deps.db.transaction(async (tx) => {
      const session = await this.getPrivileged(sessionId, tx);
      const side = await this.resolveSide(actor, session, tx);
      if (side !== 'target')
        throw forbidden('Only the remote device can change session permissions');
      if (!PERMISSION_EDITABLE_STATES.includes(session.state)) {
        throw invalidState(`Permissions cannot change while the session is ${session.state}`);
      }
      const device = await this.permissions.loadDevice(session.targetDeviceId, tx);
      if (!device) throw notFound('Session');
      const ceiling = await this.permissions.resolveAccess(session.controllerUserId, device, tx);
      const granted = normalizePermissions(intersectPermissions(requested, ceiling.permissions));
      if (!granted.includes('screen_view')) {
        throw badRequest('A session needs at least the screen view permission; end it instead');
      }
      await this.replacePermissions(tx, sessionId, granted, actor.userId);
      await this.audit.record(
        {
          action: 'PERMISSION_CHANGED',
          actorUserId: actor.userId,
          actorDeviceId: actor.deviceId,
          organizationId: session.organizationId,
          targetType: 'session',
          targetId: sessionId,
          metadata: {
            scope: 'session',
            before: session.permissions.join(','),
            after: granted.join(','),
          },
        },
        meta,
        tx,
      );
      return this.getPrivileged(sessionId, tx);
    });
  }

  /**
   * Periodic re-authorization (short-lived session authorization). Re-reads
   * the session and the controller's *current* access to the device: if the
   * device was revoked or the controller lost access, the session is failed;
   * if their ceiling shrank, the granted permissions shrink with it.
   */
  async verify(
    actor: SessionActor,
    sessionId: string,
    meta: RequestMeta,
  ): Promise<{ session: SessionRecord; side: SessionSide; ended: boolean }> {
    return this.deps.db.transaction(async (tx) => {
      const session = await this.getPrivileged(sessionId, tx);
      const side = await this.resolveSide(actor, session, tx);
      if (TERMINAL_SESSION_STATES.includes(session.state)) {
        return { session, side, ended: true };
      }
      const device = await this.permissions.loadDevice(session.targetDeviceId, tx);
      const ceiling = device
        ? await this.permissions.resolveAccess(session.controllerUserId, device, tx)
        : null;
      const allowed = normalizePermissions(
        intersectPermissions(session.permissions, ceiling?.permissions ?? []),
      );
      if (!allowed.includes('screen_view')) {
        await this.transition(tx, sessionId, 'FAILED', 'access_revoked');
        await this.audit.record(
          {
            action: 'SESSION_ENDED',
            actorUserId: actor.userId,
            actorDeviceId: actor.deviceId,
            organizationId: session.organizationId,
            targetType: 'session',
            targetId: sessionId,
            metadata: { outcome: 'access_revoked' },
          },
          meta,
          tx,
        );
        return { session: await this.getPrivileged(sessionId, tx), side, ended: true };
      }
      if (allowed.length !== session.permissions.length) {
        await this.replacePermissions(tx, sessionId, allowed, null);
        await this.audit.record(
          {
            action: 'PERMISSION_CHANGED',
            actorUserId: actor.userId,
            organizationId: session.organizationId,
            targetType: 'session',
            targetId: sessionId,
            metadata: {
              scope: 'session',
              reason: 'access_reduced',
              before: session.permissions.join(','),
              after: allowed.join(','),
            },
          },
          meta,
          tx,
        );
        return { session: await this.getPrivileged(sessionId, tx), side, ended: false };
      }
      return { session, side, ended: false };
    });
  }

  /**
   * Audit events for transfers that happen peer-to-peer. The caller must be
   * a participant, and the session must currently grant the permission the
   * event belongs to. Only sizes and hashes are stored: never names or data.
   */
  async recordPeerAudit(
    actor: SessionActor,
    sessionId: string,
    event: {
      event:
        | 'FILE_TRANSFER_STARTED'
        | 'FILE_TRANSFER_COMPLETED'
        | 'FILE_TRANSFER_CANCELLED'
        | 'CLIPBOARD_TRANSFERRED';
      direction: 'controller_to_host' | 'host_to_controller';
      bytes: number;
      sha256?: string;
    },
    meta: RequestMeta,
  ): Promise<void> {
    const session = await this.getPrivileged(sessionId);
    const side = await this.resolveSide(actor, session);
    const needed: SessionPermission =
      event.event === 'CLIPBOARD_TRANSFERRED' ? 'clipboard' : 'file_transfer';
    if (!session.permissions.includes(needed)) {
      throw forbidden(`This session does not allow ${needed.replace('_', ' ')}`);
    }
    await this.audit.record(
      {
        action: event.event,
        actorUserId: actor.userId,
        actorDeviceId: actor.deviceId,
        organizationId: session.organizationId,
        targetType: 'session',
        targetId: sessionId,
        metadata: {
          reportedBy: side,
          direction: event.direction,
          bytes: event.bytes,
          sha256: event.sha256 ?? null,
        },
      },
      meta,
    );
  }

  /** Live sessions a device takes part in (as target, or as the controller's device). */
  async liveSessionsForDevice(deviceId: string): Promise<SessionRecord[]> {
    const rows = await this.deps.db.query<SessionRow>(
      `${SESSION_SELECT}
        where (s.target_device_id = $1 or s.controller_device_id = $1)
          and s.state not in ('IDLE', 'ENDED', 'FAILED', 'EXPIRED')`,
      [deviceId],
    );
    return rows.map(toSessionRecord);
  }

  /** Every live session (signaling start-up reconciliation). */
  async allLiveSessions(): Promise<SessionRecord[]> {
    const rows = await this.deps.db.query<SessionRow>(
      `${SESSION_SELECT} where s.state not in ('IDLE', 'ENDED', 'FAILED', 'EXPIRED')`,
    );
    return rows.map(toSessionRecord);
  }

  /** Live sessions controlled by a user from a socket without device identity. */
  async liveSessionsForDevicelessController(userId: string): Promise<SessionRecord[]> {
    const rows = await this.deps.db.query<SessionRow>(
      `${SESSION_SELECT}
        where s.controller_user_id = $1 and s.controller_device_id is null
          and s.state not in ('IDLE', 'ENDED', 'FAILED', 'EXPIRED')`,
      [userId],
    );
    return rows.map(toSessionRecord);
  }

  /** Fails sessions whose participant vanished (signaling disconnect past the grace period). */
  async failSessions(sessionIds: readonly string[], reason: string): Promise<SessionRecord[]> {
    const failed: SessionRecord[] = [];
    for (const sessionId of sessionIds) {
      try {
        const session = await this.deps.db.transaction(async (tx) => {
          const current = await this.getPrivileged(sessionId, tx);
          if (TERMINAL_SESSION_STATES.includes(current.state) || current.state === 'IDLE') {
            return null;
          }
          await this.transition(tx, sessionId, 'FAILED', reason);
          await this.audit.record(
            {
              action: 'SESSION_ENDED',
              organizationId: current.organizationId,
              targetType: 'session',
              targetId: sessionId,
              metadata: { outcome: reason },
            },
            { ip: null },
            tx,
          );
          return this.getPrivileged(sessionId, tx);
        });
        if (session) failed.push(session);
      } catch (error) {
        this.deps.logger.warn({ err: error, sessionId }, 'Could not fail session');
      }
    }
    return failed;
  }

  /** Short-lived authorization: approved sessions must connect in time. */
  async expireStaleSessions(
    connectTimeoutSeconds: number,
  ): Promise<
    { sessionId: string; controllerUserId: string; targetDeviceId: string; state: SessionState }[]
  > {
    const rows = await this.deps.db.query<{
      session_id: string;
      controller_user_id: string;
      target_device_id: string;
      state: SessionState;
    }>(
      'select session_id, controller_user_id, target_device_id, state::text as state from public.expire_stale_sessions($1)',
      [connectTimeoutSeconds],
    );
    return rows.map((r) => ({
      sessionId: r.session_id,
      controllerUserId: r.controller_user_id,
      targetDeviceId: r.target_device_id,
      state: r.state,
    }));
  }
}
