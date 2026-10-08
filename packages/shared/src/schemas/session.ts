import { z } from 'zod';
import { deviceIdSchema } from '../device-id';
import { sessionStateSchema } from '../session-state';
import { boundedText, timestampSchema, uuidSchema } from './common';
import { sessionPermissionSchema } from './permission';

/** Summary status for the session history UI. Derived from `SessionState`. */
export const SESSION_STATUSES = ['connecting', 'active', 'ended', 'failed', 'rejected'] as const;
export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

const FINISHED_STATUSES: readonly SessionStatus[] = ['ended', 'failed', 'rejected'];

/** Session as shown in the desktop history UI. */
export const sessionSchema = z
  .object({
    id: uuidSchema,
    connectionRequestId: uuidSchema.nullable(),
    /** The device being controlled. */
    deviceId: deviceIdSchema,
    deviceName: boundedText(1, 64, 'Device name'),
    /** The person who initiated the session. */
    user: z.object({
      id: uuidSchema.nullable(),
      displayName: boundedText(1, 64, 'Display name'),
    }),
    status: sessionStatusSchema,
    startedAt: timestampSchema,
    endedAt: timestampSchema.nullable(),
    grantedPermissions: z.array(sessionPermissionSchema),
  })
  .refine(
    (session) =>
      session.endedAt === null || Date.parse(session.endedAt) >= Date.parse(session.startedAt),
    { message: 'A session cannot end before it starts', path: ['endedAt'] },
  )
  .refine((session) => FINISHED_STATUSES.includes(session.status) === (session.endedAt !== null), {
    message: 'Finished sessions must have an end time; live sessions must not',
    path: ['endedAt'],
  });
export type Session = z.output<typeof sessionSchema>;

/** Elapsed time of a session in milliseconds. Live sessions are measured against `now`. */
export function getSessionDurationMs(
  session: Pick<Session, 'startedAt' | 'endedAt'>,
  now: Date = new Date(),
): number {
  const start = Date.parse(session.startedAt);
  const end = session.endedAt === null ? now.getTime() : Date.parse(session.endedAt);
  return Math.max(0, end - start);
}

// ---------------------------------------------------------------------------
// API contract (apps/api /api/v1/sessions)
// ---------------------------------------------------------------------------

export const sessionRecordSchema = z.object({
  id: uuidSchema,
  connectionRequestId: uuidSchema.nullable(),
  state: sessionStateSchema,
  controllerUserId: uuidSchema,
  controllerDeviceId: uuidSchema.nullable(),
  targetDeviceId: uuidSchema,
  /** Null when the caller can no longer see the device (e.g. it left the organisation). */
  targetDeviceCode: deviceIdSchema.nullable(),
  targetDeviceName: z.string().nullable(),
  organizationId: uuidSchema.nullable(),
  permissions: z.array(sessionPermissionSchema),
  failureReason: z.string().nullable(),
  createdAt: timestampSchema,
  connectedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
});
export type SessionRecord = z.output<typeof sessionRecordSchema>;

/**
 * Transitions a participant may report through the API. Everything else is
 * driven by the server (approval, signaling, expiry, end).
 */
export const REPORTABLE_SESSION_STATES = [
  'CONNECTING',
  'CONNECTED',
  'RECONNECTING',
  'FAILED',
] as const;
export const sessionStateReportSchema = z.object({
  state: z.enum(REPORTABLE_SESSION_STATES),
  reason: z.string().trim().max(200).optional(),
});

/** Maps the server lifecycle to the coarse status the history UI shows. */
export function toSessionStatus(
  state: z.infer<typeof sessionStateSchema>,
  failureReason: string | null,
): SessionStatus {
  switch (state) {
    case 'CONNECTED':
      return 'active';
    case 'ENDED':
      return 'ended';
    case 'EXPIRED':
      return 'failed';
    case 'FAILED':
      return failureReason === 'rejected' ? 'rejected' : 'failed';
    default:
      return 'connecting';
  }
}
