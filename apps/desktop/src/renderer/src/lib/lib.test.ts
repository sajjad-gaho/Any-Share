import { deviceSchema, sessionSchema } from '@remote-desktop/shared';
import { describe, expect, it } from 'vitest';
import { buildSampleDevices, buildSampleSessions } from '@/data/sample-data';
import { DEFAULT_DEVICE_FILTERS, filterDevices, hasActiveFilters } from './filter-devices';

const devices = buildSampleDevices(Date.parse('2026-09-10T12:00:00Z'));

describe('sample data', () => {
  it('conforms to the shared schemas', () => {
    for (const device of devices) expect(deviceSchema.safeParse(device).success).toBe(true);
    for (const session of buildSampleSessions()) {
      expect(sessionSchema.safeParse(session).success).toBe(true);
    }
  });

  it('never claims an active session', () => {
    expect(buildSampleSessions().some((session) => session.status === 'active')).toBe(false);
  });
});

describe('filterDevices', () => {
  it('returns everything with default filters', () => {
    expect(filterDevices(devices, DEFAULT_DEVICE_FILTERS)).toHaveLength(devices.length);
    expect(hasActiveFilters(DEFAULT_DEVICE_FILTERS)).toBe(false);
  });

  it('filters by status and OS', () => {
    const online = filterDevices(devices, { ...DEFAULT_DEVICE_FILTERS, status: 'online' });
    expect(online.length).toBeGreaterThan(0);
    expect(online.every((device) => device.status === 'online')).toBe(true);

    const linux = filterDevices(devices, { ...DEFAULT_DEVICE_FILTERS, os: 'linux' });
    expect(linux.map((device) => device.name)).toEqual(['Build Server']);
  });

  it('searches names, tags and IDs (with or without spaces)', () => {
    const byName = filterDevices(devices, { ...DEFAULT_DEVICE_FILTERS, query: 'reception' });
    expect(byName.map((device) => device.name)).toEqual(['Reception PC']);

    const byTag = filterDevices(devices, { ...DEFAULT_DEVICE_FILTERS, query: 'KIOSK' });
    expect(byTag.map((device) => device.name)).toEqual(['Warehouse Kiosk']);

    const [target] = devices;
    if (!target) throw new Error('sample data is empty');
    const spaced = `${target.id.slice(0, 3)} ${target.id.slice(3, 6)}`;
    const byId = filterDevices(devices, { ...DEFAULT_DEVICE_FILTERS, query: spaced });
    expect(byId.map((device) => device.id)).toContain(target.id);
  });
});
