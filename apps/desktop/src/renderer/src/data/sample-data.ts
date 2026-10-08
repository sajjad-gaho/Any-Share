/**
 * SAMPLE DATA — NOT REAL.
 *
 * Shown only while signed out (signed in, pages use the API). It exists so the
 * interface can be reviewed with realistic content. The UI labels it as sample
 * data wherever it appears, and it can be switched off in Settings > General.
 */
import {
  createDeviceId,
  deviceSchema,
  sessionSchema,
  type Device,
  type Session,
} from '@remote-desktop/shared';

const MINUTE = 60_000;

function minutesAgo(now: number, minutes: number): string {
  return new Date(now - minutes * MINUTE).toISOString();
}

const DEVICE_SEEDS = [
  ['10482735', 'Reception PC', 'windows', 'Windows 11 Pro 24H2', 'online', 1, ['front-office']],
  ['20915846', 'Design Workstation', 'windows', 'Windows 11 Pro 24H2', 'online', 3, ['studio']],
  ['31740219', 'Finance Laptop', 'windows', 'Windows 10 Pro 22H2', 'offline', 260, ['finance']],
  ['42067358', 'Build Server', 'linux', 'Ubuntu 24.04 LTS', 'online', 0, ['infra']],
  ['53381904', 'Marketing MacBook', 'macos', 'macOS 15 Sequoia', 'offline', 1_900, []],
  ['64729013', 'Warehouse Kiosk', 'windows', 'Windows 11 IoT Enterprise', 'online', 12, ['kiosk']],
  ['75106482', 'Conference Room', 'windows', 'Windows 11 Pro 23H2', 'offline', 8_700, []],
  ['86450127', 'Field Tablet', 'android', 'Android 15', 'offline', 45, ['field']],
] as const;

export function buildSampleDevices(now = Date.now()): Device[] {
  return DEVICE_SEEDS.map(([payload, name, family, version, status, lastSeen, tags]) =>
    deviceSchema.parse({
      id: createDeviceId(payload),
      name,
      os: { family, version },
      status,
      lastSeenAt: minutesAgo(now, lastSeen),
      organizationId: null,
      ownerId: null,
      tags: [...tags],
    }),
  );
}

// prettier-ignore
const SESSION_SEEDS = [
  // [id, device payload, device name, user, status, started (min ago), duration (min)]
  ['f5423a6b-6b6f-4a69-8da8-7e9c2a0ef4f5', '10482735', 'Reception PC', 'Alex Morgan', 'ended', 95, 18],
  ['d27b1c26-570a-41da-80b8-6ccdf45173c1', '42067358', 'Build Server', 'Sam Patel', 'ended', 340, 52],
  ['2641b945-7178-4f69-b936-b79de14cc6c4', '20915846', 'Design Workstation', 'Alex Morgan', 'failed', 1_200, 0],
  ['15b9509c-d3e9-4cfc-b034-ee82677cd6e1', '64729013', 'Warehouse Kiosk', 'Jordan Lee', 'ended', 2_900, 7],
  ['6df6b95d-b820-486a-babb-bc83bf754ebb', '31740219', 'Finance Laptop', 'Sam Patel', 'rejected', 4_400, 0],
  ['98546de1-4b41-41aa-afa5-137f0efa65ed', '53381904', 'Marketing MacBook', 'Jordan Lee', 'ended', 9_800, 124],
  ['6322fafb-bb9c-479e-9cbf-79965dfdbe3e', '10482735', 'Reception PC', 'Alex Morgan', 'ended', 14_500, 31],
  ['e96583ab-afd9-4914-b3d2-e50665449e90', '75106482', 'Conference Room', 'Sam Patel', 'ended', 21_000, 64],
] as const;

export function buildSampleSessions(now = Date.now()): Session[] {
  return SESSION_SEEDS.map(([id, payload, deviceName, user, status, started, duration]) =>
    sessionSchema.parse({
      id,
      connectionRequestId: null,
      deviceId: createDeviceId(payload),
      deviceName,
      user: { id: null, displayName: user },
      status,
      startedAt: minutesAgo(now, started),
      endedAt: minutesAgo(now, started - duration),
      grantedPermissions:
        status === 'ended'
          ? ['screen_view', 'mouse', 'keyboard', 'remote_control']
          : ['screen_view'],
    }),
  );
}
