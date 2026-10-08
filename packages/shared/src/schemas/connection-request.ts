import { z } from 'zod';
import { deviceIdSchema } from '../device-id';
import { timestampSchema, uuidSchema } from './common';
import { sessionPermissionSchema, sessionPermissionSetSchema } from './permission';

export const CONNECTION_REQUEST_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled',
] as const;
export const connectionRequestStatusSchema = z.enum(CONNECTION_REQUEST_STATUSES);
export type ConnectionRequestStatus = z.infer<typeof connectionRequestStatusSchema>;

export const connectionMessageSchema = z
  .string()
  .trim()
  .max(280, 'Message must be at most 280 characters');

/** Bounded so a client cannot make the server hash megabytes with Argon2. */
export const accessPasswordSchema = z.string().min(8).max(128);

/** What a controller submits when it asks to connect to a device. */
export const connectionRequestInputSchema = z.object({
  targetDeviceId: deviceIdSchema,
  requestedPermissions: sessionPermissionSetSchema.default(['screen_view']),
  message: connectionMessageSchema.optional(),
  /** Required only when the target device has an access password configured. */
  accessPassword: accessPasswordSchema.optional(),
});
export type ConnectionRequestInput = z.input<typeof connectionRequestInputSchema>;

/** A connection request as returned by the API. */
export const connectionRequestSchema = z.object({
  id: uuidSchema,
  sessionId: uuidSchema,
  controllerUserId: uuidSchema,
  controllerDeviceId: uuidSchema.nullable(),
  targetDeviceId: uuidSchema,
  targetDeviceCode: deviceIdSchema,
  requestedPermissions: z.array(sessionPermissionSchema),
  message: z.string().nullable(),
  status: connectionRequestStatusSchema,
  respondedBy: uuidSchema.nullable(),
  respondedAt: timestampSchema.nullable(),
  expiresAt: timestampSchema,
  createdAt: timestampSchema,
});
export type ConnectionRequest = z.output<typeof connectionRequestSchema>;
