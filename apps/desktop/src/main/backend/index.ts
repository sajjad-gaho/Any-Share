import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';
import { AuthSession } from './auth-session';
import { resolveApiBaseUrl, resolveSignalingUrl } from './config';
import { DeviceIdentity } from './device-identity';
import { ApiError, createHttpClient, type HttpClient } from './http';
import { EncryptedFileSecretStore } from './secret-store';

export interface Backend {
  /** Null when no API URL is configured for this build. */
  apiBaseUrl: string | null;
  signalingUrl: string | null;
  auth: AuthSession;
  device: DeviceIdentity;
}

const unconfigured: HttpClient = {
  request: () =>
    Promise.reject(new ApiError(0, 'not_configured', 'This build is not connected to a server.')),
};

/** Wires the main-process backend client. Call after `app.whenReady()`. */
export function createBackend(): Backend {
  // LAN test builds only: plain http/ws to a private LAN address (baked in at build time).
  const allowLanHttp = import.meta.env.MAIN_VITE_ALLOW_LAN_HTTP === 'true';
  const apiBaseUrl = resolveApiBaseUrl(
    import.meta.env.MAIN_VITE_API_URL,
    app.isPackaged,
    allowLanHttp,
  );
  const http = apiBaseUrl ? createHttpClient(apiBaseUrl) : unconfigured;
  const store = new EncryptedFileSecretStore(
    join(app.getPath('userData'), 'secure-store.json'),
    {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plaintext) => safeStorage.encryptString(plaintext),
      decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
    },
    {
      readFile: (path) => readFile(path, 'utf8').catch(() => null),
      async writeFileAtomic(path, data) {
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.tmp`;
        await writeFile(temp, data, { encoding: 'utf8', mode: 0o600 });
        await rename(temp, path);
      },
    },
  );
  const auth = new AuthSession(http, store);
  const device = new DeviceIdentity(store, auth, {
    platform: process.platform,
    release: release(),
  });
  const signalingUrl = resolveSignalingUrl(
    import.meta.env.MAIN_VITE_SIGNALING_URL,
    app.isPackaged,
    allowLanHttp,
  );
  if (allowLanHttp) {
    console.warn('[backend] LAN test build: unencrypted http/ws allowed to private LAN addresses');
  }
  return { apiBaseUrl, signalingUrl, auth, device };
}
