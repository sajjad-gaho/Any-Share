import type { Device, Session } from '@remote-desktop/shared';
import { createApiRepository } from '@/data/api-repository';
import { createPreviewRepository } from '@/data/preview-repository';
import { getDesktopApi } from '@/lib/desktop-api';
import { useAuthStore } from './auth-store';
import { createCollectionStore } from './collection-store';
import { useSettingsStore } from './settings-store';

const preview = createPreviewRepository(() => useSettingsStore.getState().showSampleData);

/** Signed in: real data from the API. Signed out: the labelled sample dataset (if enabled). */
function repository() {
  const api = getDesktopApi();
  const auth = useAuthStore.getState();
  if (api && auth.status === 'signed-in') {
    return createApiRepository(api, () => useAuthStore.getState().user?.id ?? null);
  }
  return preview;
}

export const devicesStore = createCollectionStore<Device>(() => repository().listDevices());
export const sessionsStore = createCollectionStore<Session>(() => repository().listSessions());
