import {
  normalizePermissions,
  permissionSetProblem,
  sortPermissions,
  type ConnectionRequest,
  type ConnectionRequestStatus,
  type SessionPermission,
  type SessionRecord,
} from '@remote-desktop/shared';
import { asUser, type Queryable } from '../db/types';
import { badRequest, conflict, expired, forbidden, invalidState, notFound } from '../errors';
import { verifySecret } from '../security/argon2';
import type { AuditService } from './audit-service';
import { toIso, toIsoOrNull, type RequestMeta, type ServiceDeps } from './context';
import type { DevicesService } from './devices-service';
import type { PermissionsService } from './permissions-service';
import type { SessionActor, SessionsService } from './sessions-service';
import type { UsersService } from './users-service';

interface RequestRow {
  id: string;
  session_id: string;
  controller_user_id: string;
  controller_device_id: string | null;
  target_device_id: string;
  target_device_code: string;
  requested_permissions: SessionPermission[];
  message: string | null;
  status: ConnectionRequestStatus;
  responded_by: string | null;
  responded_at: Date | string | null;
  expires_at: Date | string;
  created_at: Date | string;
}

const REQUEST_SELECT = `select cr.id, s.id as session_id, cr.controller_user_id, cr.controller_device_id,
    cr.target_device_id, d.device_code as target_device_code,
    cr.requested_permissions::text[] as requested_permissions, cr.message, cr.status::text as status,
    cr.responded_by, cr.responded_at, cr.expires_at, cr.created_at
  from public.connection_requests cr
  join public.sessions s on s.connection_request_id = cr.id
  join public.devices d on d.id = cr.target_device_id`;

const toRequest = (row: RequestRow): ConnectionRequest => ({
  id: row.id,
  sessionId: row.session_id,
  controllerUserId: row.controller_user_id,
  controllerDeviceId: row.controller_device_id,
  targetDeviceId: row.target_device_id,
  targetDeviceCode: row.target_device_code,
  requestedPermissions: sortPermissions(row.requested_permissions),
  message: row.message,
  status: row.status,
  respondedBy: row.responded_by,
  respondedAt: toIsoOrNull(row.responded_at),
  expiresAt: toIso(row.expires_at),
  createdAt: toIso(row.created_at),
});

export interface CreateConnectionInput {
  targetDeviceCode: string;
  permissions: SessionPermission[];
  message?: string;
  accessPassword?: string;
}

export interface CreatedConnection {
  request: ConnectionRequest;
  session: SessionRecord;
  /** True when no approval was needed (device owner, or a grant without approval). */
  autoApproved: boolean;
  controllerDisplayName: string | null;
}

export interface ExpiredRequest {
  requestId: string;
  sessionId: string | null;
  controllerUserId: string;
  targetDeviceId: string;
}

export class ConnectionService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
    private readonly devices: DevicesService,
    private readonly sessions: SessionsService,
    private readonly users: UsersService,
  ) {}

  /**
   * A controller asks to connect to the device with `targetDeviceCode`.
   * Authorisation is entirely server-side: the caller's identity comes from
   * their token, their access from the database, and the requested
   * permissions must fit inside that access.
   */
  async create(
    controller: SessionActor,
    input: CreateConnectionInput,
    meta: RequestMeta,
  ): Promise<CreatedConnection> {
    const { limiters } = this.deps;
    limiters.connectionRequests.consumeOrThrow(`user:${controller.userId}`);
    limiters.deviceLookup.consumeOrThrow(`user:${controller.userId}`);

    const device = await this.permissions.loadDeviceByCode(input.targetDeviceCode);
    // Unknown, revoked and not-yours all look the same: device codes cannot be probed.
    if (!device || device.revoked_at !== null) throw notFound('Device');
    const access = await this.permissions.resolveAccess(controller.userId, device);
    if (access.relation === 'none') throw notFound('Device');
    if (controller.deviceId === device.id) throw badRequest('A device cannot connect to itself');

    const requested = sortPermissions(input.permissions);
    const problem = permissionSetProblem(requested);
    if (problem) throw badRequest(problem);
    const excess = requested.filter((p) => !access.permissions.includes(p));
    if (excess.length > 0) {
      throw forbidden(`Not allowed on this device: ${excess.join(', ')}`);
    }

    // Access password: a second factor for anyone but the owner. Brute force is
    // throttled per (device, user) so one attacker cannot lock out everyone.
    if (access.relation !== 'owner') {
      const hash = await this.devices.getAccessPasswordHash(device.id);
      if (hash) {
        const guardKey = `device:${device.id}:user:${controller.userId}`;
        limiters.accessPasswordGuard.assertNotLocked(guardKey);
        if (!input.accessPassword || !(await verifySecret(hash, input.accessPassword))) {
          limiters.accessPasswordGuard.recordFailure(guardKey);
          throw forbidden('This device requires its access password');
        }
        limiters.accessPasswordGuard.recordSuccess(guardKey);
      }
    }

    const ttl = this.deps.settings.connectionRequestTtlSeconds;
    const result = await this.deps.db.transaction(async (tx) => {
      const [pending] = await tx.query(
        `select 1 from public.connection_requests
          where controller_user_id = $1 and target_device_id = $2
            and status = 'pending' and expires_at > now()`,
        [controller.userId, device.id],
      );
      if (pending) throw conflict('You already have a pending request to this device');

      const [request] = await tx.query<{ id: string }>(
        `insert into public.connection_requests
           (controller_user_id, controller_device_id, target_device_id, requested_permissions,
            message, expires_at)
         values ($1, $2, $3, $4::public.session_permission[], $5,
                 now() + make_interval(secs => $6))
         returning id`,
        [controller.userId, controller.deviceId, device.id, requested, input.message ?? null, ttl],
      );
      if (!request) throw new Error('Insert returned no row');
      const [session] = await tx.query<{ id: string }>(
        `insert into public.sessions
           (connection_request_id, controller_user_id, controller_device_id, target_device_id,
            organization_id, state)
         values ($1, $2, $3, $4, $5, 'REQUESTING')
         returning id`,
        [request.id, controller.userId, controller.deviceId, device.id, device.organization_id],
      );
      if (!session) throw new Error('Insert returned no row');

      await this.audit.record(
        {
          action: 'CONNECTION_REQUESTED',
          actorUserId: controller.userId,
          actorDeviceId: controller.deviceId,
          organizationId: device.organization_id,
          targetType: 'connection_request',
          targetId: request.id,
          metadata: {
            targetDeviceId: device.id,
            permissions: requested.join(','),
            relation: access.relation,
          },
        },
        meta,
        tx,
      );

      if (access.requireApproval) {
        await this.sessions.transition(tx, session.id, 'APPROVAL_PENDING');
      } else {
        await tx.query(
          `update public.connection_requests set status = 'approved', responded_by = null
            where id = $1`,
          [request.id],
        );
        await this.sessions.transition(tx, session.id, 'AUTHORIZING');
        await this.sessions.replacePermissions(tx, session.id, requested, null);
        await this.sessions.transition(tx, session.id, 'SIGNALING');
        await this.audit.record(
          {
            action: 'CONNECTION_APPROVED',
            actorUserId: controller.userId,
            organizationId: device.organization_id,
            targetType: 'connection_request',
            targetId: request.id,
            metadata: { automatic: true, permissions: requested.join(',') },
          },
          meta,
          tx,
        );
      }
      return {
        request: await this.getPrivileged(request.id, tx),
        session: await this.sessions.getPrivileged(session.id, tx),
      };
    });

    return {
      ...result,
      autoApproved: !access.requireApproval,
      controllerDisplayName: await this.users.getDisplayName(controller.userId),
    };
  }

  /**
   * The person at the remote device accepts. Must come from the target device
   * itself (a device-authenticated socket), by a user who manages it.
   */
  async approve(
    actor: SessionActor,
    requestId: string,
    narrowedPermissions: SessionPermission[] | undefined,
    meta: RequestMeta,
  ): Promise<{ request: ConnectionRequest; session: SessionRecord }> {
    return this.deps.db.transaction(async (tx) => {
      const request = await this.loadForResponse(actor, requestId, tx);

      let granted = request.requestedPermissions;
      if (narrowedPermissions) {
        const extra = narrowedPermissions.filter((p) => !request.requestedPermissions.includes(p));
        if (extra.length > 0)
          throw badRequest('Cannot approve permissions that were not requested');
        granted = normalizePermissions(narrowedPermissions);
      }
      // The controller's access may have changed while the request was pending.
      const device = await this.permissions.loadDevice(request.targetDeviceId, tx);
      if (!device) throw notFound('Connection request');
      const controllerAccess = await this.permissions.resolveAccess(
        request.controllerUserId,
        device,
        tx,
      );
      granted = normalizePermissions(
        granted.filter((p) => controllerAccess.permissions.includes(p)),
      );
      if (!granted.includes('screen_view')) {
        throw forbidden('The requester is no longer allowed to connect to this device');
      }

      await tx.query(
        `update public.connection_requests set status = 'approved', responded_by = $2 where id = $1`,
        [requestId, actor.userId],
      );
      await this.sessions.transition(tx, request.sessionId, 'AUTHORIZING');
      await this.sessions.replacePermissions(tx, request.sessionId, granted, actor.userId);
      await this.sessions.transition(tx, request.sessionId, 'SIGNALING');
      await this.audit.record(
        {
          action: 'CONNECTION_APPROVED',
          actorUserId: actor.userId,
          actorDeviceId: actor.deviceId,
          organizationId: device.organization_id,
          targetType: 'connection_request',
          targetId: requestId,
          metadata: { automatic: false, permissions: granted.join(',') },
        },
        meta,
        tx,
      );
      return {
        request: await this.getPrivileged(requestId, tx),
        session: await this.sessions.getPrivileged(request.sessionId, tx),
      };
    });
  }

  async reject(
    actor: SessionActor,
    requestId: string,
    reason: string | null,
    meta: RequestMeta,
  ): Promise<{ request: ConnectionRequest; session: SessionRecord }> {
    return this.deps.db.transaction(async (tx) => {
      const request = await this.loadForResponse(actor, requestId, tx);
      await tx.query(
        `update public.connection_requests set status = 'rejected', responded_by = $2 where id = $1`,
        [requestId, actor.userId],
      );
      await this.sessions.transition(tx, request.sessionId, 'FAILED', 'rejected');
      const device = await this.permissions.loadDevice(request.targetDeviceId, tx);
      await this.audit.record(
        {
          action: 'CONNECTION_REJECTED',
          actorUserId: actor.userId,
          actorDeviceId: actor.deviceId,
          organizationId: device?.organization_id ?? null,
          targetType: 'connection_request',
          targetId: requestId,
          metadata: { reason },
        },
        meta,
        tx,
      );
      return {
        request: await this.getPrivileged(requestId, tx),
        session: await this.sessions.getPrivileged(request.sessionId, tx),
      };
    });
  }

  /** The controller withdraws a pending request. */
  async cancel(userId: string, requestId: string): Promise<ConnectionRequest> {
    return this.deps.db.transaction(async (tx) => {
      const request = await this.getPrivileged(requestId, tx, true);
      if (request.controllerUserId !== userId) throw notFound('Connection request');
      if (request.status !== 'pending') throw invalidState(`Request is already ${request.status}`);
      await tx.query(
        `update public.connection_requests set status = 'cancelled', responded_by = $2 where id = $1`,
        [requestId, userId],
      );
      await this.sessions.transition(tx, request.sessionId, 'ENDED', 'cancelled');
      return this.getPrivileged(requestId, tx);
    });
  }

  async list(
    userId: string,
    options: {
      direction: 'incoming' | 'outgoing';
      status?: ConnectionRequestStatus;
      limit: number;
    },
  ): Promise<ConnectionRequest[]> {
    const rows = await asUser(this.deps.db, userId, (tx) =>
      tx.query<RequestRow>(
        `${REQUEST_SELECT}
          where ($1 = 'outgoing') = (cr.controller_user_id = $2)
            and ($3::public.connection_request_status is null or cr.status = $3)
          order by cr.created_at desc
          limit $4`,
        [options.direction, userId, options.status ?? null, options.limit],
      ),
    );
    return rows.map(toRequest);
  }

  async get(userId: string, requestId: string): Promise<ConnectionRequest> {
    const [row] = await asUser(this.deps.db, userId, (tx) =>
      tx.query<RequestRow>(`${REQUEST_SELECT} where cr.id = $1`, [requestId]),
    );
    if (!row) throw notFound('Connection request');
    return toRequest(row);
  }

  /** Expires every pending request past its deadline. Idempotent; safe to run often. */
  async expireStale(): Promise<ExpiredRequest[]> {
    const rows = await this.deps.db.query<{
      request_id: string;
      session_id: string | null;
      controller_user_id: string;
      target_device_id: string;
    }>('select * from public.expire_connection_requests()');
    return rows.map((r) => ({
      requestId: r.request_id,
      sessionId: r.session_id,
      controllerUserId: r.controller_user_id,
      targetDeviceId: r.target_device_id,
    }));
  }

  private async getPrivileged(
    requestId: string,
    tx: Queryable,
    lock = false,
  ): Promise<ConnectionRequest> {
    const [row] = await tx.query<RequestRow>(
      `${REQUEST_SELECT} where cr.id = $1${lock ? ' for update of cr' : ''}`,
      [requestId],
    );
    if (!row) throw notFound('Connection request');
    return toRequest(row);
  }

  /** Shared checks for approve/reject: right device, right user, still pending, not expired. */
  private async loadForResponse(
    actor: SessionActor,
    requestId: string,
    tx: Queryable,
  ): Promise<ConnectionRequest> {
    const request = await this.getPrivileged(requestId, tx, true);
    if (actor.deviceId !== request.targetDeviceId) throw notFound('Connection request');
    const device = await this.permissions.loadDevice(request.targetDeviceId, tx);
    if (!device) throw notFound('Connection request');
    const access = await this.permissions.resolveAccess(actor.userId, device, tx);
    if (!access.canManage) throw notFound('Connection request');

    if (request.status !== 'pending') throw invalidState(`Request is already ${request.status}`);
    if (Date.parse(request.expiresAt) <= Date.now()) {
      throw expired('Connection request has expired');
    }
    return request;
  }
}
