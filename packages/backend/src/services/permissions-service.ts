import { ROLE_SESSION_CEILING } from '@remote-desktop/security';
import {
  SESSION_PERMISSIONS,
  sortPermissions,
  type DeviceAccess,
  type DevicePermission,
  type Role,
  type SessionPermission,
} from '@remote-desktop/shared';
import type { Queryable } from '../db/types';
import { badRequest, forbidden, notFound } from '../errors';
import type { AuditService } from './audit-service';
import { toIso, type RequestMeta, type ServiceDeps } from './context';

/** The columns authorisation decisions depend on. Always read server-side. */
export interface DeviceAuthRow {
  id: string;
  device_code: string;
  owner_id: string;
  organization_id: string | null;
  require_approval: boolean;
  revoked_at: Date | string | null;
}

interface DevicePermissionRow {
  device_id: string;
  user_id: string;
  permissions: SessionPermission[];
  require_approval: boolean;
  granted_by: string | null;
  updated_at: Date | string;
}

const toDevicePermission = (row: DevicePermissionRow): DevicePermission => ({
  deviceId: row.device_id,
  userId: row.user_id,
  permissions: sortPermissions(row.permissions),
  requireApproval: row.require_approval,
  grantedBy: row.granted_by,
  updatedAt: toIso(row.updated_at),
});

const NO_ACCESS = (deviceId: string): DeviceAccess => ({
  deviceId,
  relation: 'none',
  permissions: [],
  requireApproval: true,
  canManage: false,
});

export class PermissionsService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
  ) {}

  async loadDevice(deviceId: string, tx?: Queryable): Promise<DeviceAuthRow | undefined> {
    const [row] = await (tx ?? this.deps.db).query<DeviceAuthRow>(
      `select id, device_code, owner_id, organization_id, require_approval, revoked_at
         from public.devices where id = $1`,
      [deviceId],
    );
    return row;
  }

  async loadDeviceByCode(deviceCode: string, tx?: Queryable): Promise<DeviceAuthRow | undefined> {
    const [row] = await (tx ?? this.deps.db).query<DeviceAuthRow>(
      `select id, device_code, owner_id, organization_id, require_approval, revoked_at
         from public.devices where device_code = $1`,
      [deviceCode],
    );
    return row;
  }

  /**
   * Effective access of `userId` to `device`, computed from database facts only:
   *   1. the device owner may do everything without approval;
   *   2. an explicit `device_permissions` row for an organisation member is
   *      their ceiling (it can widen a `user` or narrow an `operator`);
   *   3. otherwise the member's role ceiling applies, with the device's
   *      approval setting;
   *   4. anyone else has no access — another user's personal device is
   *      never reachable.
   * Revoked devices grant nothing.
   */
  async resolveAccess(
    userId: string,
    device: DeviceAuthRow,
    tx?: Queryable,
  ): Promise<DeviceAccess> {
    if (device.revoked_at !== null) return NO_ACCESS(device.id);
    if (device.owner_id === userId) {
      return {
        deviceId: device.id,
        relation: 'owner',
        permissions: [...SESSION_PERMISSIONS],
        requireApproval: false,
        canManage: true,
      };
    }
    if (!device.organization_id) return NO_ACCESS(device.id);

    const q = tx ?? this.deps.db;
    const [membership] = await q.query<{ role: Role }>(
      `select role::text as role from public.organization_members
        where organization_id = $1 and user_id = $2`,
      [device.organization_id, userId],
    );
    if (!membership) return NO_ACCESS(device.id);
    const canManage = membership.role === 'owner' || membership.role === 'admin';

    const [grant] = await q.query<DevicePermissionRow>(
      `select device_id, user_id, permissions::text[] as permissions, require_approval,
              granted_by, updated_at
         from public.device_permissions where device_id = $1 and user_id = $2`,
      [device.id, userId],
    );
    if (grant) {
      return {
        deviceId: device.id,
        relation: 'grant',
        permissions: sortPermissions(grant.permissions),
        requireApproval: grant.require_approval,
        canManage,
      };
    }
    const ceiling = ROLE_SESSION_CEILING[membership.role];
    if (ceiling.length === 0) return { ...NO_ACCESS(device.id), canManage };
    return {
      deviceId: device.id,
      relation: 'organization',
      permissions: [...ceiling],
      requireApproval: device.require_approval,
      canManage,
    };
  }

  /** Access for a device id; 404 when the device does not exist or is invisible to the caller. */
  async accessFor(userId: string, deviceId: string, tx?: Queryable) {
    const device = await this.loadDevice(deviceId, tx);
    if (!device) throw notFound('Device');
    const access = await this.resolveAccess(userId, device, tx);
    if (access.relation === 'none' && !access.canManage) throw notFound('Device');
    return { device, access };
  }

  /** Loads a device the caller may manage (owner, or org owner/admin). */
  async requireManage(userId: string, deviceId: string, tx?: Queryable): Promise<DeviceAuthRow> {
    const { device, access } = await this.accessFor(userId, deviceId, tx);
    if (!access.canManage)
      throw forbidden('Only the device owner or an organization admin can do that');
    if (device.revoked_at !== null) throw notFound('Device');
    return device;
  }

  async listDevicePermissions(actorId: string, deviceId: string): Promise<DevicePermission[]> {
    await this.requireManage(actorId, deviceId);
    const rows = await this.deps.db.query<DevicePermissionRow>(
      `select device_id, user_id, permissions::text[] as permissions, require_approval,
              granted_by, updated_at
         from public.device_permissions where device_id = $1 order by created_at`,
      [deviceId],
    );
    return rows.map(toDevicePermission);
  }

  async setDevicePermission(
    actorId: string,
    deviceId: string,
    input: { userId: string; permissions: SessionPermission[]; requireApproval: boolean },
    meta: RequestMeta,
  ): Promise<DevicePermission> {
    return this.deps.db.transaction(async (tx) => {
      const device = await this.requireManage(actorId, deviceId, tx);
      if (!device.organization_id) {
        throw badRequest('Move the device into an organization before sharing it');
      }
      if (input.userId === device.owner_id) throw badRequest('The owner already has full access');
      const [member] = await tx.query(
        'select 1 from public.organization_members where organization_id = $1 and user_id = $2',
        [device.organization_id, input.userId],
      );
      if (!member) throw badRequest('Permissions can only be granted to organization members');

      const permissions = sortPermissions(input.permissions);
      const [row] = await tx.query<DevicePermissionRow>(
        `insert into public.device_permissions (device_id, user_id, permissions, require_approval, granted_by)
         values ($1, $2, $3::public.session_permission[], $4, $5)
         on conflict (device_id, user_id) do update
           set permissions = excluded.permissions,
               require_approval = excluded.require_approval,
               granted_by = excluded.granted_by
         returning device_id, user_id, permissions::text[] as permissions, require_approval,
                   granted_by, updated_at`,
        [deviceId, input.userId, permissions, input.requireApproval, actorId],
      );
      if (!row) throw new Error('Upsert returned no row');
      await this.audit.record(
        {
          action: 'PERMISSION_CHANGED',
          actorUserId: actorId,
          organizationId: device.organization_id,
          targetType: 'device',
          targetId: deviceId,
          metadata: {
            scope: 'device',
            subjectUserId: input.userId,
            permissions: permissions.join(','),
            requireApproval: input.requireApproval,
          },
        },
        meta,
        tx,
      );
      return toDevicePermission(row);
    });
  }

  async removeDevicePermission(
    actorId: string,
    deviceId: string,
    userId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const device = await this.requireManage(actorId, deviceId, tx);
      const deleted = await tx.query(
        'delete from public.device_permissions where device_id = $1 and user_id = $2 returning id',
        [deviceId, userId],
      );
      if (deleted.length === 0) throw notFound('Permission');
      await this.audit.record(
        {
          action: 'PERMISSION_CHANGED',
          actorUserId: actorId,
          organizationId: device.organization_id,
          targetType: 'device',
          targetId: deviceId,
          metadata: { scope: 'device', subjectUserId: userId, permissions: 'revoked' },
        },
        meta,
        tx,
      );
    });
  }
}
