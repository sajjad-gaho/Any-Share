import {
  deviceSchema,
  sessionSchema,
  type DeviceRecord,
  type SessionRecord,
} from '@remote-desktop/shared';
import { describe, expect, it } from 'vitest';
import { toDeviceViewModel, toSessionViewModel } from './api-mapping';

const ME = '6c1a7c1e-6e2f-4d6a-9a43-3c1d2f0b7a11';
const OTHER = '41b4c51e-6104-443a-b05a-62640705759c';
const T0 = '2026-10-03T10:00:00.000Z';
const T1 = '2026-10-03T10:30:00.000Z';

const device: DeviceRecord = {
  id: OTHER,
  deviceCode: '123456782',
  name: 'Kiosk',
  os: { family: 'windows', version: 'Windows 11' },
  ownerId: ME,
  organizationId: null,
  tags: ['front'],
  status: 'online',
  requireApproval: true,
  hasAccessPassword: false,
  keyFingerprint: 'a'.repeat(64),
  lastSeenAt: null,
  revokedAt: null,
  createdAt: T0,
};

const session: SessionRecord = {
  id: OTHER,
  connectionRequestId: null,
  state: 'ENDED',
  controllerUserId: ME,
  controllerDeviceId: null,
  targetDeviceId: OTHER,
  targetDeviceCode: '123456782',
  targetDeviceName: 'Kiosk',
  organizationId: null,
  permissions: ['screen_view'],
  failureReason: null,
  createdAt: T0,
  connectedAt: T0,
  endedAt: T1,
};

describe('toDeviceViewModel', () => {
  it('uses the public code as the UI id and produces a valid device', () => {
    const vm = toDeviceViewModel(device);
    expect(vm.id).toBe('123456782');
    expect(vm.lastSeenAt).toBe(T0);
    expect(deviceSchema.safeParse(vm).success).toBe(true);
  });
});

describe('toSessionViewModel', () => {
  it('maps finished and live sessions', () => {
    expect(toSessionViewModel(session, ME)).toMatchObject({
      status: 'ended',
      endedAt: T1,
      user: { displayName: 'You' },
    });
    const live = toSessionViewModel({ ...session, state: 'CONNECTED', endedAt: null }, OTHER);
    expect(live).toMatchObject({
      status: 'active',
      endedAt: null,
      user: { displayName: 'Another user' },
    });
    expect(sessionSchema.safeParse(live).success).toBe(true);
    expect(
      toSessionViewModel({ ...session, state: 'FAILED', failureReason: 'rejected' }, ME)?.status,
    ).toBe('rejected');
  });

  it('skips sessions whose device is no longer visible', () => {
    expect(
      toSessionViewModel({ ...session, targetDeviceCode: null, targetDeviceName: null }, ME),
    ).toBeNull();
  });
});
