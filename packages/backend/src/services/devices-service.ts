import { hasCapability } from '@remote-desktop/security';
import type {
  DeviceRecord,
  OsFamily,
  deviceRegistrationInputSchema,
  deviceUpdateInputSchema,
} from '@remote-desktop/shared';
import type { z } from 'zod';
import { asUser, type Queryable } from '../db/types';
import { PG, conflict, forbidden, notFound, pgErrorCode } from '../errors';
import { hashSecret } from '../security/argon2';
import {
  generateDeviceCode,
  parseDevicePublicKey,
  publicKeyFingerprint,
} from '../security/device-identity';
import type { AuditService } from './audit-service';
import { toIso, toIsoOrNull, type RequestMeta, type ServiceDeps } from './context';
import type { OrganizationsService } from './organizations-service';
import type { PermissionsService } from './permissions-service';

type RegistrationInput = z.output<typeof deviceRegistrationInputSchema>;
type UpdateInput = z.output<typeof deviceUpdateInputSchema>;

interface DeviceRow {
  id: string;
  device_code: string;
  name: string;
  os_family: OsFamily;
  os_version: string;
  owner_id: string;
  organization_id: string | null;
  tags: string[];
  require_approval: boolean;
  key_fingerprint: string;
  is_online: boolean;
  last_seen_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
  has_access_password: boolean;
}

const DEVICE_COLUMNS = `d.id, d.device_code, d.name, d.os_family::text as os_family, d.os_version,
  d.owner_id, d.organization_id, d.tags, d.require_approval, d.key_fingerprint, d.is_online,
  d.last_seen_at, d.revoked_at, d.created_at`;

/** Under RLS the credentials table is invisible, so use the definer helper. */
const USER_DEVICE_SELECT = `select ${DEVICE_COLUMNS},
  private.device_has_access_password(d.id) as has_access_password from public.devices d`;

const PRIVILEGED_DEVICE_SELECT = `select ${DEVICE_COLUMNS},
  exists (select 1 from public.device_credentials c
           where c.device_id = d.id and c.kind = 'access_password' and c.revoked_at is null)
    as has_access_password
  from public.devices d`;

const MAX_CODE_ATTEMPTS = 5;

export class DevicesService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
    private readonly organizations: OrganizationsService,
    private readonly permissions: PermissionsService,
  ) {}

  private toRecord(row: DeviceRow): DeviceRecord {
    const lastSeen = row.last_seen_at === null ? null : new Date(toIso(row.last_seen_at));
    const fresh =
      lastSeen !== null &&
      Date.now() - lastSeen.getTime() < this.deps.settings.presenceStaleAfterMs;
    return {
      id: row.id,
      deviceCode: row.device_code,
      name: row.name,
      os: { family: row.os_family, version: row.os_version },
      ownerId: row.owner_id,
      organizationId: row.organization_id,
      tags: row.tags,
      status: row.is_online && fresh && row.revoked_at === null ? 'online' : 'offline',
      requireApproval: row.require_approval,
      hasAccessPassword: row.has_access_password,
      keyFingerprint: row.key_fingerprint,
      lastSeenAt: toIsoOrNull(row.last_seen_at),
      revokedAt: toIsoOrNull(row.revoked_at),
      createdAt: toIso(row.created_at),
    };
  }

  /** Devices visible to the caller under RLS (own, organisation, granted). */
  async list(userId: string, options: { organizationId?: string } = {}): Promise<DeviceRecord[]> {
    const rows = await asUser(this.deps.db, userId, (tx) =>
      tx.query<DeviceRow>(
        `${USER_DEVICE_SELECT}
          where d.revoked_at is null and ($1::uuid is null or d.organization_id = $1)
          order by d.name`,
        [options.organizationId ?? null],
      ),
    );
    return rows.map((row) => this.toRecord(row));
  }

  async get(userId: string, deviceId: string): Promise<DeviceRecord> {
    const [row] = await asUser(this.deps.db, userId, (tx) =>
      tx.query<DeviceRow>(`${USER_DEVICE_SELECT} where d.id = $1`, [deviceId]),
    );
    if (!row) throw notFound('Device');
    return this.toRecord(row);
  }

  private async getPrivileged(deviceId: string, tx: Queryable): Promise<DeviceRecord> {
    const [row] = await tx.query<DeviceRow>(`${PRIVILEGED_DEVICE_SELECT} where d.id = $1`, [
      deviceId,
    ]);
    if (!row) throw notFound('Device');
    return this.toRecord(row);
  }

  /**
   * Registers a device owned by the caller. The server generates the public
   * device code; the client supplies only its Ed25519 public key.
   */
  async register(
    userId: string,
    input: RegistrationInput,
    meta: RequestMeta,
  ): Promise<DeviceRecord> {
    parseDevicePublicKey(input.publicKey);
    const fingerprint = publicKeyFingerprint(input.publicKey);

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.deps.db.transaction(async (tx) => {
          if (input.organizationId) {
            await this.organizations.requireCapability(
              userId,
              input.organizationId,
              'device.manage',
              tx,
            );
          }
          const [device] = await tx.query<{ id: string }>(
            `insert into public.devices
               (device_code, owner_id, organization_id, name, os_family, os_version, tags, key_fingerprint)
             values ($1, $2, $3, $4, $5::public.os_family, $6, $7::text[], $8)
             returning id`,
            [
              generateDeviceCode(),
              userId,
              input.organizationId ?? null,
              input.name,
              input.os.family,
              input.os.version,
              input.tags ?? [],
              fingerprint,
            ],
          );
          if (!device) throw new Error('Insert returned no row');
          await tx.query(
            `insert into public.device_credentials (device_id, kind, public_key)
             values ($1, 'ed25519_public_key', $2)`,
            [device.id, input.publicKey],
          );
          await this.audit.record(
            {
              action: 'DEVICE_REGISTERED',
              actorUserId: userId,
              actorDeviceId: device.id,
              organizationId: input.organizationId ?? null,
              targetType: 'device',
              targetId: device.id,
              metadata: { osFamily: input.os.family, keyFingerprint: fingerprint },
            },
            meta,
            tx,
          );
          return this.getPrivileged(device.id, tx);
        });
      } catch (error) {
        if (pgErrorCode(error) !== PG.uniqueViolation) throw error;
        const { constraint, message } = error as { constraint?: string; message?: string };
        if (`${constraint ?? ''} ${message ?? ''}`.includes('devices_active_key_idx')) {
          throw conflict('This device key is already registered');
        }
        // Device code collision (1 in 10^8 per existing device): try another code.
        if (attempt >= MAX_CODE_ATTEMPTS) throw error;
      }
    }
  }

  async update(
    userId: string,
    deviceId: string,
    input: UpdateInput,
    meta: RequestMeta,
  ): Promise<DeviceRecord> {
    const passwordHash =
      typeof input.accessPassword === 'string' ? await hashSecret(input.accessPassword) : null;

    return this.deps.db.transaction(async (tx) => {
      const device = await this.permissions.requireManage(userId, deviceId, tx);

      if (input.organizationId !== undefined && input.organizationId !== device.organization_id) {
        // Only the owner moves a device between organisations, and only into
        // one where they may manage devices.
        if (device.owner_id !== userId) throw forbidden('Only the device owner can move it');
        if (input.organizationId !== null) {
          const role = await this.organizations.getRole(userId, input.organizationId, tx);
          if (!role) throw notFound('Organization');
          if (!hasCapability(role, 'device.manage')) throw forbidden();
        }
        // Grants belonged to the old organisation's members.
        await tx.query('delete from public.device_permissions where device_id = $1', [deviceId]);
      }

      await tx.query(
        `update public.devices set
           name = coalesce($2, name),
           tags = coalesce($3::text[], tags),
           organization_id = case when $4::boolean then $5::uuid else organization_id end,
           require_approval = coalesce($6, require_approval)
         where id = $1`,
        [
          deviceId,
          input.name ?? null,
          input.tags ?? null,
          input.organizationId !== undefined,
          input.organizationId ?? null,
          input.requireApproval ?? null,
        ],
      );

      if (input.accessPassword !== undefined) {
        await tx.query(
          `update public.device_credentials set revoked_at = now()
            where device_id = $1 and kind = 'access_password' and revoked_at is null`,
          [deviceId],
        );
        if (passwordHash) {
          await tx.query(
            `insert into public.device_credentials (device_id, kind, secret_hash)
             values ($1, 'access_password', $2)`,
            [deviceId, passwordHash],
          );
        }
      }

      if (input.requireApproval !== undefined || input.accessPassword !== undefined) {
        await this.audit.record(
          {
            action: 'PERMISSION_CHANGED',
            actorUserId: userId,
            organizationId: device.organization_id,
            targetType: 'device',
            targetId: deviceId,
            metadata: {
              scope: 'device_settings',
              requireApproval: input.requireApproval ?? null,
              accessPasswordChanged: input.accessPassword !== undefined,
            },
          },
          meta,
          tx,
        );
      }
      return this.getPrivileged(deviceId, tx);
    });
  }

  /**
   * Revokes a device: credentials and grants are invalidated, pending requests
   * cancelled and live sessions failed. The row stays for the audit trail.
   */
  async revoke(
    userId: string,
    deviceId: string,
    meta: RequestMeta,
  ): Promise<{ sessionIds: string[] }> {
    return this.deps.db.transaction(async (tx) => {
      const device = await this.permissions.requireManage(userId, deviceId, tx);
      await tx.query(
        'update public.devices set revoked_at = now(), is_online = false where id = $1',
        [deviceId],
      );
      await tx.query(
        'update public.device_credentials set revoked_at = now() where device_id = $1 and revoked_at is null',
        [deviceId],
      );
      await tx.query('delete from public.device_permissions where device_id = $1', [deviceId]);
      await tx.query(
        `update public.connection_requests set status = 'cancelled'
          where status = 'pending' and (target_device_id = $1 or controller_device_id = $1)`,
        [deviceId],
      );
      const sessions = await tx.query<{ id: string }>(
        `update public.sessions set state = 'FAILED', failure_reason = 'device_revoked'
          where (target_device_id = $1 or controller_device_id = $1)
            and state not in ('IDLE', 'ENDED', 'FAILED', 'EXPIRED')
          returning id`,
        [deviceId],
      );
      await this.audit.record(
        {
          action: 'DEVICE_REVOKED',
          actorUserId: userId,
          organizationId: device.organization_id,
          targetType: 'device',
          targetId: deviceId,
          metadata: { deviceCode: device.device_code, endedSessions: sessions.length },
        },
        meta,
        tx,
      );
      return { sessionIds: sessions.map((s) => s.id) };
    });
  }

  /** Public key of a live device, for signature verification. Never returned to clients. */
  async getPublicKey(deviceId: string): Promise<string | null> {
    const [row] = await this.deps.db.query<{ public_key: string }>(
      `select c.public_key from public.device_credentials c
         join public.devices d on d.id = c.device_id
        where c.device_id = $1 and c.kind = 'ed25519_public_key'
          and c.revoked_at is null and d.revoked_at is null`,
      [deviceId],
    );
    return row?.public_key ?? null;
  }

  async getAccessPasswordHash(deviceId: string, tx?: Queryable): Promise<string | null> {
    const [row] = await (tx ?? this.deps.db).query<{ secret_hash: string }>(
      `select secret_hash from public.device_credentials
        where device_id = $1 and kind = 'access_password' and revoked_at is null`,
      [deviceId],
    );
    return row?.secret_hash ?? null;
  }

  /** Presence: flip online/offline on connect/disconnect. */
  async setOnline(deviceId: string, online: boolean): Promise<void> {
    await this.deps.db.query(
      'update public.devices set is_online = $2, last_seen_at = now() where id = $1',
      [deviceId, online],
    );
  }

  /** Presence: one batched write for every device seen since the last flush. */
  async touchLastSeen(deviceIds: readonly string[]): Promise<void> {
    if (deviceIds.length === 0) return;
    await this.deps.db.query(
      'update public.devices set last_seen_at = now() where id = any($1::uuid[]) and revoked_at is null',
      [deviceIds],
    );
  }

  /** Which of these devices have been revoked (their sockets must be closed). */
  async findRevoked(deviceIds: readonly string[]): Promise<string[]> {
    if (deviceIds.length === 0) return [];
    const rows = await this.deps.db.query<{ id: string }>(
      'select id from public.devices where id = any($1::uuid[]) and revoked_at is not null',
      [deviceIds],
    );
    return rows.map((r) => r.id);
  }

  /** On signaling start-up: nothing is connected to this instance yet. */
  async markAllOffline(): Promise<void> {
    await this.deps.db.query('update public.devices set is_online = false where is_online');
  }

  /** Users who should hear about this device's presence (owner, org admins/operators, grantees). */
  async presenceAudience(deviceId: string): Promise<string[]> {
    const rows = await this.deps.db.query<{ user_id: string }>(
      `select d.owner_id as user_id from public.devices d where d.id = $1
       union
       select m.user_id from public.devices d
         join public.organization_members m on m.organization_id = d.organization_id
        where d.id = $1 and m.role in ('owner', 'admin', 'operator')
       union
       select p.user_id from public.device_permissions p where p.device_id = $1`,
      [deviceId],
    );
    return rows.map((r) => r.user_id);
  }
}
