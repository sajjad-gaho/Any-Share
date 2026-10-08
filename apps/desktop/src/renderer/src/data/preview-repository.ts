import type { DeviceRepository, SessionRepository } from './repositories';
import { buildSampleDevices, buildSampleSessions } from './sample-data';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Signed-out repository. Returns the clearly-labelled sample dataset when
 * sample data is enabled, otherwise nothing. A short artificial delay keeps
 * loading states honest to how the network-backed repository behaves.
 * Signed in, `createApiRepository` is used instead (see stores/app-stores.ts).
 */
export function createPreviewRepository(
  isSampleDataEnabled: () => boolean,
  latencyMs = 300,
): DeviceRepository & SessionRepository {
  return {
    async listDevices() {
      await delay(latencyMs);
      return isSampleDataEnabled() ? buildSampleDevices() : [];
    },
    async listSessions() {
      await delay(latencyMs);
      return isSampleDataEnabled() ? buildSampleSessions() : [];
    },
  };
}
