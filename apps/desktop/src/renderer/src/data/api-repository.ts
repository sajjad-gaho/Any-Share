import type { DesktopApi } from '../../../shared/ipc';
import { toDeviceViewModel, toSessionViewModel } from './api-mapping';
import type { DeviceRepository, SessionRepository } from './repositories';

/**
 * Repository backed by apps/api through the main process. The renderer never
 * holds a token: it asks main, which calls the API as the signed-in user, and
 * the server (plus RLS) decides what that user may see.
 */
export function createApiRepository(
  api: DesktopApi,
  currentUserId: () => string | null,
): DeviceRepository & SessionRepository {
  return {
    async listDevices() {
      const result = await api.devices.list();
      if (!result.ok) throw new Error(result.error.message);
      return result.value.map(toDeviceViewModel);
    },
    async listSessions() {
      const result = await api.sessions.list();
      if (!result.ok) throw new Error(result.error.message);
      const userId = currentUserId() ?? '';
      return result.value.flatMap((record) => toSessionViewModel(record, userId) ?? []);
    },
  };
}
