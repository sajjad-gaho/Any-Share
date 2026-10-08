import { describe, expect, it } from 'vitest';
import { createDeviceId } from '../device-id';
import { auditLogSchema } from './audit-log';
import { connectionRequestInputSchema, connectionRequestSchema } from './connection-request';
import { deviceRegistrationInputSchema, deviceSchema, deviceUpdateInputSchema } from './device';
import { organizationSchema } from './organization';
import {
  intersectPermissions,
  normalizePermissions,
  sessionPermissionSchema,
  sessionPermissionSetSchema,
} from './permission';
import { getSessionDurationMs, sessionSchema, toSessionStatus } from './session';
import { passwordResetConfirmSchema, registerInputSchema } from './auth';
import { contactInputSchema, profileInputSchema, searchQuerySchema, userSchema } from './user';

const DEVICE_A = createDeviceId('12345678');
const DEVICE_B = createDeviceId('87654321');
const UUID_1 = 'ba049211-720d-4c15-a74b-0882a42841ed';
const UUID_2 = '41b4c51e-6104-443a-b05a-62640705759c';
const T0 = '2026-09-01T10:00:00.000Z';
const T1 = '2026-09-01T10:42:30.000Z';

describe('permissions', () => {
  it('accepts known permissions only', () => {
    expect(sessionPermissionSchema.safeParse('screen_view').success).toBe(true);
    expect(sessionPermissionSchema.safeParse('root_shell').success).toBe(false);
  });

  it('requires screen_view, non-empty and unique session permission sets', () => {
    expect(sessionPermissionSetSchema.safeParse(['screen_view']).success).toBe(true);
    expect(sessionPermissionSetSchema.safeParse([]).success).toBe(false);
    expect(sessionPermissionSetSchema.safeParse(['clipboard']).success).toBe(false);
    expect(sessionPermissionSetSchema.safeParse(['screen_view', 'screen_view']).success).toBe(
      false,
    );
    // Organisation capabilities are not grantable per session.
    expect(sessionPermissionSetSchema.safeParse(['screen_view', 'audit.view']).success).toBe(false);
  });

  it('requires remote_control for mouse and keyboard', () => {
    expect(sessionPermissionSetSchema.safeParse(['screen_view', 'mouse']).success).toBe(false);
    expect(
      sessionPermissionSetSchema.safeParse(['screen_view', 'mouse', 'remote_control']).success,
    ).toBe(true);
  });

  it('intersects and normalises sets', () => {
    expect(
      intersectPermissions(['remote_control', 'screen_view', 'mouse'], ['mouse', 'screen_view']),
    ).toEqual(['screen_view', 'mouse']);
    expect(normalizePermissions(['mouse', 'screen_view', 'keyboard'])).toEqual(['screen_view']);
    expect(normalizePermissions(['keyboard', 'remote_control', 'screen_view'])).toEqual([
      'screen_view',
      'keyboard',
      'remote_control',
    ]);
  });
});

describe('user input', () => {
  it('trims and validates display names', () => {
    expect(profileInputSchema.parse({ displayName: '  Ada  ' })).toEqual({ displayName: 'Ada' });
    expect(profileInputSchema.safeParse({ displayName: '   ' }).success).toBe(false);
    expect(profileInputSchema.safeParse({ displayName: 'a'.repeat(65) }).success).toBe(false);
    expect(profileInputSchema.safeParse({ displayName: 'bad\u0007name' }).success).toBe(false);
  });

  it('bounds search queries', () => {
    expect(searchQuerySchema.parse('  laptop ')).toBe('laptop');
    expect(searchQuerySchema.safeParse('x'.repeat(101)).success).toBe(false);
  });

  it('normalises address-book contacts', () => {
    expect(
      contactInputSchema.parse({ alias: ' Front desk ', deviceId: '123 456 782', notes: '  ' }),
    ).toEqual({ alias: 'Front desk', deviceId: DEVICE_A, notes: undefined });
    expect(contactInputSchema.safeParse({ alias: 'X', deviceId: '123456789' }).success).toBe(false);
  });

  it('validates full users', () => {
    const user = {
      id: UUID_1,
      email: 'ada@example.com',
      displayName: 'Ada',
      avatarUrl: null,
      createdAt: T0,
      memberships: [{ organizationId: UUID_2, organizationName: 'Acme', role: 'operator' }],
    };
    expect(userSchema.safeParse(user).success).toBe(true);
    expect(userSchema.safeParse({ ...user, email: 'not-an-email' }).success).toBe(false);
    expect(
      userSchema.safeParse({
        ...user,
        memberships: [{ organizationId: UUID_2, organizationName: 'Acme', role: 'superuser' }],
      }).success,
    ).toBe(false);
    expect(
      userSchema.safeParse({ ...user, avatarUrl: 'http://insecure.example.com/a.png' }).success,
    ).toBe(false);
  });
});

describe('organizationSchema', () => {
  it('validates slugs', () => {
    const org = { id: UUID_1, name: 'Acme', slug: 'acme-it', plan: 'team', createdAt: T0 };
    expect(organizationSchema.safeParse(org).success).toBe(true);
    expect(organizationSchema.safeParse({ ...org, slug: 'Acme IT' }).success).toBe(false);
    expect(organizationSchema.safeParse({ ...org, slug: '-acme' }).success).toBe(false);
  });
});

describe('deviceSchema', () => {
  it('validates a device and defaults tags', () => {
    const parsed = deviceSchema.parse({
      id: '123 456 782',
      name: 'Reception PC',
      os: { family: 'windows', version: 'Windows 11 23H2' },
      status: 'online',
      lastSeenAt: T0,
      organizationId: null,
      ownerId: null,
    });
    expect(parsed.id).toBe(DEVICE_A);
    expect(parsed.tags).toEqual([]);
  });
});

describe('connection requests', () => {
  it('defaults requested permissions to view-only', () => {
    expect(connectionRequestInputSchema.parse({ targetDeviceId: DEVICE_B })).toEqual({
      targetDeviceId: DEVICE_B,
      requestedPermissions: ['screen_view'],
    });
  });

  it('rejects invalid target IDs and oversized access passwords', () => {
    expect(connectionRequestInputSchema.safeParse({ targetDeviceId: '000000001' }).success).toBe(
      false,
    );
    expect(
      connectionRequestInputSchema.safeParse({
        targetDeviceId: DEVICE_B,
        accessPassword: 'x'.repeat(129),
      }).success,
    ).toBe(false);
  });

  it('accepts a well-formed request record', () => {
    expect(
      connectionRequestSchema.safeParse({
        id: UUID_1,
        sessionId: UUID_2,
        controllerUserId: UUID_2,
        controllerDeviceId: null,
        targetDeviceId: UUID_1,
        targetDeviceCode: DEVICE_A,
        requestedPermissions: ['screen_view'],
        message: null,
        status: 'pending',
        respondedBy: null,
        respondedAt: null,
        expiresAt: T1,
        createdAt: T0,
      }).success,
    ).toBe(true);
  });
});

describe('device API input', () => {
  const publicKey = 'MCowBQYDK2VwAyEA' + 'A'.repeat(43) + '=';

  it('validates registration', () => {
    const input = { name: 'PC', os: { family: 'windows', version: '11' }, publicKey };
    expect(deviceRegistrationInputSchema.safeParse(input).success).toBe(true);
    expect(deviceRegistrationInputSchema.safeParse({ ...input, publicKey: 'abc' }).success).toBe(
      false,
    );
  });

  it('rejects empty or unknown updates', () => {
    expect(deviceUpdateInputSchema.safeParse({}).success).toBe(false);
    expect(deviceUpdateInputSchema.safeParse({ ownerId: UUID_1 }).success).toBe(false);
    expect(deviceUpdateInputSchema.safeParse({ name: 'New name' }).success).toBe(true);
  });
});

describe('sessionSchema', () => {
  const session = {
    id: UUID_1,
    connectionRequestId: null,
    deviceId: DEVICE_A,
    deviceName: 'Reception PC',
    user: { id: UUID_2, displayName: 'Ada' },
    status: 'ended',
    startedAt: T0,
    endedAt: T1,
    grantedPermissions: ['screen_view'],
  };

  it('accepts a finished session', () => {
    expect(sessionSchema.safeParse(session).success).toBe(true);
  });

  it('enforces consistency between status and end time', () => {
    expect(sessionSchema.safeParse({ ...session, endedAt: null }).success).toBe(false);
    expect(sessionSchema.safeParse({ ...session, status: 'active' }).success).toBe(false);
    expect(sessionSchema.safeParse({ ...session, status: 'active', endedAt: null }).success).toBe(
      true,
    );
  });

  it('rejects sessions that end before they start', () => {
    expect(sessionSchema.safeParse({ ...session, startedAt: T1, endedAt: T0 }).success).toBe(false);
  });

  it('computes durations', () => {
    expect(getSessionDurationMs({ startedAt: T0, endedAt: T1 })).toBe(42.5 * 60 * 1000);
    expect(getSessionDurationMs({ startedAt: T0, endedAt: null }, new Date(T1))).toBe(
      42.5 * 60 * 1000,
    );
  });
});

describe('auditLogSchema', () => {
  it('accepts primitive metadata only', () => {
    const entry = {
      id: UUID_1,
      organizationId: UUID_2,
      action: 'SESSION_STARTED',
      actorUserId: UUID_2,
      actorDeviceId: null,
      targetType: 'device',
      targetId: DEVICE_A,
      metadata: { durationMs: 1000, viaRelay: false, note: null },
      ipAddress: '203.0.113.7',
      createdAt: T0,
    };
    expect(auditLogSchema.safeParse(entry).success).toBe(true);
    expect(auditLogSchema.safeParse({ ...entry, metadata: { nested: { a: 1 } } }).success).toBe(
      false,
    );
    expect(auditLogSchema.safeParse({ ...entry, ipAddress: '999.1.1.1' }).success).toBe(false);
    expect(auditLogSchema.safeParse({ ...entry, action: 'session.started' }).success).toBe(false);
  });
});

describe('auth input', () => {
  it('validates registration and reset payloads', () => {
    expect(
      registerInputSchema.safeParse({ email: 'a@example.com', password: 'short', displayName: 'A' })
        .success,
    ).toBe(false);
    expect(
      registerInputSchema.safeParse({
        email: 'a@example.com',
        password: 'long enough pw',
        displayName: 'A',
      }).success,
    ).toBe(true);
    expect(
      passwordResetConfirmSchema.safeParse({
        email: 'a@example.com',
        code: 'abc',
        newPassword: 'long enough pw',
      }).success,
    ).toBe(false);
  });
});

describe('toSessionStatus', () => {
  it('maps lifecycle states to history statuses', () => {
    expect(toSessionStatus('CONNECTED', null)).toBe('active');
    expect(toSessionStatus('FAILED', 'rejected')).toBe('rejected');
    expect(toSessionStatus('EXPIRED', null)).toBe('failed');
    expect(toSessionStatus('SIGNALING', null)).toBe('connecting');
  });
});
