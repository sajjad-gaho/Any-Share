import {
  sessionSchema,
  toSessionStatus,
  type Device,
  type DeviceRecord,
  type Session,
  type SessionRecord,
} from '@remote-desktop/shared';

/** API device record -> the view model the device UI was built around (9-digit code as `id`). */
export function toDeviceViewModel(record: DeviceRecord): Device {
  return {
    id: record.deviceCode,
    name: record.name,
    os: record.os,
    status: record.status,
    lastSeenAt: record.lastSeenAt ?? record.createdAt,
    organizationId: record.organizationId,
    ownerId: record.ownerId,
    tags: record.tags,
  };
}

/**
 * API session record -> history row. Sessions whose device the caller can no
 * longer see are skipped rather than shown with invented details.
 */
export function toSessionViewModel(record: SessionRecord, currentUserId: string): Session | null {
  if (!record.targetDeviceCode || !record.targetDeviceName) return null;
  const status = toSessionStatus(record.state, record.failureReason);
  const live = status === 'active' || status === 'connecting';
  const parsed = sessionSchema.safeParse({
    id: record.id,
    connectionRequestId: record.connectionRequestId,
    deviceId: record.targetDeviceCode,
    deviceName: record.targetDeviceName,
    user: {
      id: record.controllerUserId,
      displayName: record.controllerUserId === currentUserId ? 'You' : 'Another user',
    },
    status,
    startedAt: record.createdAt,
    endedAt: live ? null : (record.endedAt ?? record.createdAt),
    grantedPermissions: record.permissions,
  });
  return parsed.success ? parsed.data : null;
}
