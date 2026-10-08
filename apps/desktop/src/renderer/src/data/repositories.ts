import type { Device, Session } from '@remote-desktop/shared';

/**
 * Data access boundary. The UI depends only on these interfaces so the Phase 1
 * preview implementation can be swapped for the Supabase-backed one later
 * without touching pages or stores.
 */
export interface DeviceRepository {
  listDevices(): Promise<Device[]>;
}

export interface SessionRepository {
  listSessions(): Promise<Session[]>;
}
