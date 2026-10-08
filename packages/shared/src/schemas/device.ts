import { z } from 'zod';
import { deviceIdSchema } from '../device-id';
import { boundedText, timestampSchema, uuidSchema } from './common';
import { accessPasswordSchema } from './connection-request';
import { sessionPermissionSchema, sessionPermissionSetSchema } from './permission';

export const OS_FAMILIES = ['windows', 'macos', 'linux', 'android', 'ios'] as const;
export const osFamilySchema = z.enum(OS_FAMILIES);
export type OsFamily = z.infer<typeof osFamilySchema>;

export const DEVICE_STATUSES = ['online', 'offline'] as const;
export const deviceStatusSchema = z.enum(DEVICE_STATUSES);
export type DeviceStatus = z.infer<typeof deviceStatusSchema>;

export const deviceNameSchema = boundedText(1, 64, 'Device name');
export const osVersionSchema = boundedText(1, 64, 'OS version');
const tagsSchema = z.array(boundedText(1, 32, 'Tag')).max(20);

/**
 * Device as shown in the desktop UI. `id` is the public 9-digit device ID (see
 * device-id.ts) because that is what people read out and type in.
 */
export const deviceSchema = z.object({
  id: deviceIdSchema,
  name: deviceNameSchema,
  os: z.object({
    family: osFamilySchema,
    version: osVersionSchema,
  }),
  status: deviceStatusSchema,
  lastSeenAt: timestampSchema,
  organizationId: uuidSchema.nullable(),
  ownerId: uuidSchema.nullable(),
  tags: tagsSchema.default([]),
});
export type Device = z.output<typeof deviceSchema>;

// ---------------------------------------------------------------------------
// API contract (apps/api /api/v1/devices)
// ---------------------------------------------------------------------------

/**
 * Ed25519 public key, SubjectPublicKeyInfo DER, base64. 44 bytes of DER encode to
 * 60 base64 characters. The private key never leaves the device.
 */
export const devicePublicKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{59}=$/, 'Expected a base64 Ed25519 SPKI public key');

export const deviceRegistrationInputSchema = z.object({
  name: deviceNameSchema,
  os: z.object({ family: osFamilySchema, version: osVersionSchema }),
  publicKey: devicePublicKeySchema,
  /** Optional: register straight into an organisation the caller administers. */
  organizationId: uuidSchema.optional(),
  tags: tagsSchema.optional(),
});
export type DeviceRegistrationInput = z.input<typeof deviceRegistrationInputSchema>;

export const deviceUpdateInputSchema = z
  .object({
    name: deviceNameSchema.optional(),
    tags: tagsSchema.optional(),
    /** Move into an organisation (or out of one with null). */
    organizationId: uuidSchema.nullable().optional(),
    requireApproval: z.boolean().optional(),
    /** Sets (string) or clears (null) the device access password. Hashed with Argon2id. */
    accessPassword: accessPasswordSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');
export type DeviceUpdateInput = z.input<typeof deviceUpdateInputSchema>;

/** Device as returned by the API. */
export const deviceRecordSchema = z.object({
  id: uuidSchema,
  deviceCode: deviceIdSchema,
  name: deviceNameSchema,
  os: z.object({ family: osFamilySchema, version: osVersionSchema }),
  ownerId: uuidSchema,
  organizationId: uuidSchema.nullable(),
  tags: z.array(z.string()),
  status: deviceStatusSchema,
  requireApproval: z.boolean(),
  hasAccessPassword: z.boolean(),
  keyFingerprint: z.string(),
  lastSeenAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type DeviceRecord = z.output<typeof deviceRecordSchema>;

/** Per-user permission ceiling on a device (`device_permissions`). */
export const devicePermissionInputSchema = z.object({
  userId: uuidSchema,
  permissions: sessionPermissionSetSchema,
  requireApproval: z.boolean().default(true),
});
export type DevicePermissionInput = z.input<typeof devicePermissionInputSchema>;

export const devicePermissionSchema = z.object({
  deviceId: uuidSchema,
  userId: uuidSchema,
  permissions: z.array(sessionPermissionSchema),
  requireApproval: z.boolean(),
  grantedBy: uuidSchema.nullable(),
  updatedAt: timestampSchema,
});
export type DevicePermission = z.output<typeof devicePermissionSchema>;

/** Effective access a user has to a device, as computed server-side. */
export const deviceAccessSchema = z.object({
  deviceId: uuidSchema,
  relation: z.enum(['owner', 'organization', 'grant', 'none']),
  permissions: z.array(sessionPermissionSchema),
  requireApproval: z.boolean(),
  canManage: z.boolean(),
});
export type DeviceAccess = z.output<typeof deviceAccessSchema>;
