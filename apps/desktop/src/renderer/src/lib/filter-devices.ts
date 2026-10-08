import {
  normalizeDeviceId,
  type Device,
  type DeviceStatus,
  type OsFamily,
} from '@remote-desktop/shared';

export interface DeviceFilters {
  query: string;
  status: 'all' | DeviceStatus;
  os: 'all' | OsFamily;
}

export const DEFAULT_DEVICE_FILTERS: DeviceFilters = { query: '', status: 'all', os: 'all' };

export function hasActiveFilters(filters: DeviceFilters): boolean {
  return filters.query.trim() !== '' || filters.status !== 'all' || filters.os !== 'all';
}

/** Case-insensitive match on name, OS version and tags; digit match on device ID. */
export function filterDevices(devices: readonly Device[], filters: DeviceFilters): Device[] {
  const query = filters.query.trim().toLowerCase();
  const idQuery = normalizeDeviceId(query);

  return devices.filter((device) => {
    if (filters.status !== 'all' && device.status !== filters.status) return false;
    if (filters.os !== 'all' && device.os.family !== filters.os) return false;
    if (!query) return true;
    return (
      device.name.toLowerCase().includes(query) ||
      device.os.version.toLowerCase().includes(query) ||
      device.tags.some((tag) => tag.toLowerCase().includes(query)) ||
      (/^\d+$/.test(idQuery) && device.id.includes(idQuery))
    );
  });
}
