import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { deviceRecordSchema, type OsFamily } from '@remote-desktop/shared';
import { z } from 'zod';
import type { ThisDevice } from '../../shared/ipc';
import type { AuthSession } from './auth-session';
import { ApiError } from './http';
import type { SecretStore } from './secret-store';

const thisDeviceSchema = z.object({
  deviceId: z.uuid(),
  deviceCode: z.string(),
  name: z.string(),
  keyFingerprint: z.string(),
});

export interface PlatformInfo {
  platform: NodeJS.Platform;
  release: string;
}

export function osFamilyFor(platform: NodeJS.Platform): OsFamily {
  switch (platform) {
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    case 'android':
      return 'android';
    default:
      return 'windows';
  }
}

/**
 * This computer's cryptographic identity.
 *
 * An Ed25519 key pair is generated locally per signed-in account. The private
 * key is stored only through the SecretStore (encrypted with the OS keystore)
 * and never leaves the main process; the server receives the public key and
 * assigns the public 9-digit device ID. The signaling service later asks the
 * device to sign a one-time nonce with this key (see `sign`).
 */
export class DeviceIdentity {
  constructor(
    private readonly store: SecretStore,
    private readonly auth: AuthSession,
    private readonly platform: PlatformInfo,
  ) {}

  private keys(userId: string) {
    return { privateKey: `device.${userId}.privateKey`, record: `device.${userId}.record` };
  }

  private currentUserId(): string | null {
    const state = this.auth.getState();
    return state.status === 'signed-in' ? state.user.id : null;
  }

  async get(): Promise<ThisDevice | null> {
    const userId = this.currentUserId();
    if (!userId) return null;
    const raw = await this.store.read(this.keys(userId).record);
    if (!raw) return null;
    try {
      const parsed = thisDeviceSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async register(name: string): Promise<ThisDevice> {
    const userId = this.currentUserId();
    if (!userId) throw new ApiError(401, 'unauthenticated', 'Sign in to register this device.');
    const existing = await this.get();
    if (existing) return existing;

    const privateKey = await this.loadOrCreatePrivateKey(userId);
    const publicKey = createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' })
      .toString('base64');
    const record = await this.auth.authorized({
      method: 'POST',
      path: '/api/v1/devices',
      body: {
        name,
        os: {
          family: osFamilyFor(this.platform.platform),
          version: this.platform.release.slice(0, 64),
        },
        publicKey,
      },
      schema: deviceRecordSchema,
    });
    const device: ThisDevice = {
      deviceId: record.id,
      deviceCode: record.deviceCode,
      name: record.name,
      keyFingerprint: record.keyFingerprint,
    };
    await this.store.write(this.keys(userId).record, JSON.stringify(device));
    return device;
  }

  /** Signs a signaling challenge. Used by the signaling client; never exposed to the renderer. */
  async sign(message: string): Promise<string | null> {
    const userId = this.currentUserId();
    if (!userId) return null;
    const stored = await this.store.read(this.keys(userId).privateKey);
    if (!stored) return null;
    const key = createPrivateKey({
      key: Buffer.from(stored, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    return sign(null, Buffer.from(message, 'utf8'), key).toString('base64');
  }

  private async loadOrCreatePrivateKey(userId: string): Promise<KeyObject> {
    const stored = await this.store.read(this.keys(userId).privateKey);
    if (stored) {
      return createPrivateKey({ key: Buffer.from(stored, 'base64'), format: 'der', type: 'pkcs8' });
    }
    const { privateKey } = generateKeyPairSync('ed25519');
    await this.store.write(
      this.keys(userId).privateKey,
      privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    );
    return privateKey;
  }
}
