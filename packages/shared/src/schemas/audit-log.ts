import { z } from 'zod';
import { timestampSchema, uuidSchema } from './common';

export const AUDIT_ACTIONS = [
  'LOGIN',
  'LOGOUT',
  'DEVICE_REGISTERED',
  'DEVICE_REVOKED',
  'CONNECTION_REQUESTED',
  'CONNECTION_APPROVED',
  'CONNECTION_REJECTED',
  'SESSION_STARTED',
  'SESSION_ENDED',
  'PERMISSION_CHANGED',
  'FILE_TRANSFER_STARTED',
  'FILE_TRANSFER_COMPLETED',
  'FILE_TRANSFER_CANCELLED',
  'CLIPBOARD_TRANSFERRED',
] as const;
export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const AUDIT_TARGET_TYPES = [
  'user',
  'device',
  'session',
  'connection_request',
  'organization',
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/** Flat, primitive-only metadata keeps audit records queryable and safe to render. */
export const auditMetadataSchema = z.record(
  z.string().max(64),
  z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
);
export type AuditMetadata = z.infer<typeof auditMetadataSchema>;

export const auditLogSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema.nullable(),
  action: auditActionSchema,
  actorUserId: uuidSchema.nullable(),
  actorDeviceId: uuidSchema.nullable(),
  targetType: z.enum(AUDIT_TARGET_TYPES).nullable(),
  targetId: z.string().min(1).max(128).nullable(),
  metadata: auditMetadataSchema,
  ipAddress: z.union([z.ipv4(), z.ipv6()]).nullable(),
  createdAt: timestampSchema,
});
export type AuditLog = z.infer<typeof auditLogSchema>;
