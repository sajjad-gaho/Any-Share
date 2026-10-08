import type { AuditAction, AuditLog, AuditTargetType } from '@remote-desktop/shared';
import { asUser, type Queryable } from '../db/types';
import { sanitizeAuditMetadata } from '../security/sanitize';
import { toIso, type RequestMeta, type ServiceDeps } from './context';

export interface AuditEntry {
  action: AuditAction;
  actorUserId?: string | null;
  actorDeviceId?: string | null;
  organizationId?: string | null;
  targetType?: AuditTargetType;
  targetId?: string;
  /** Sanitised before storage: secrets and user content are dropped. */
  metadata?: Record<string, unknown>;
}

interface AuditRow {
  id: string;
  organization_id: string | null;
  action: AuditLog['action'];
  actor_user_id: string | null;
  actor_device_id: string | null;
  target_type: AuditLog['targetType'];
  target_id: string | null;
  metadata: AuditLog['metadata'];
  ip_address: string | null;
  created_at: Date | string;
}

export class AuditService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Appends an entry. Pass `tx` to make the entry atomic with the action it
   * describes. Outside a transaction, a failed audit write is logged and does
   * not undo an action that already happened.
   */
  async record(entry: AuditEntry, meta: RequestMeta, tx?: Queryable): Promise<void> {
    const params = [
      entry.organizationId ?? null,
      entry.actorUserId ?? null,
      entry.actorDeviceId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      JSON.stringify(sanitizeAuditMetadata(entry.metadata)),
      meta.ip,
    ];
    const sql = `insert into public.audit_logs
        (organization_id, actor_user_id, actor_device_id, action, target_type, target_id, metadata, ip_address)
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::inet)`;
    if (tx) {
      await tx.query(sql, params);
      return;
    }
    try {
      await this.deps.db.query(sql, params);
    } catch (error) {
      this.deps.logger.error({ err: error, action: entry.action }, 'Failed to write audit log');
    }
  }

  /** Entries the caller may see under RLS: their own, plus their organisations' if admin. */
  async list(
    userId: string,
    options: { organizationId?: string; limit: number; before?: string },
  ): Promise<AuditLog[]> {
    const rows = await asUser(this.deps.db, userId, (tx) =>
      tx.query<AuditRow>(
        `select id, organization_id, action::text as action, actor_user_id, actor_device_id,
                target_type, target_id, metadata, host(ip_address) as ip_address, created_at
           from public.audit_logs
          where ($1::uuid is null or organization_id = $1)
            and ($2::timestamptz is null or created_at < $2)
          order by created_at desc
          limit $3`,
        [options.organizationId ?? null, options.before ?? null, options.limit],
      ),
    );
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      action: row.action,
      actorUserId: row.actor_user_id,
      actorDeviceId: row.actor_device_id,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: row.metadata,
      ipAddress: row.ip_address,
      createdAt: toIso(row.created_at),
    }));
  }
}
