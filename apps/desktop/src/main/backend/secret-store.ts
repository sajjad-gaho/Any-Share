/** Small key/value store for secrets (refresh token, device private key). */
export interface SecretStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Process-lifetime store: used in tests and when OS encryption is unavailable. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async read(key: string) {
    return this.values.get(key) ?? null;
  }
  async write(key: string, value: string) {
    this.values.set(key, value);
  }
  async remove(key: string) {
    this.values.delete(key);
  }
}

export interface Encryptor {
  isAvailable(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

export interface FileIo {
  readFile(path: string): Promise<string | null>;
  writeFileAtomic(path: string, data: string): Promise<void>;
}

/**
 * Persists secrets in one JSON file whose *values* are encrypted with the OS
 * keystore (Electron safeStorage: DPAPI on Windows). If encryption is not
 * available, secrets are kept in memory only — never written in plaintext —
 * and the user simply signs in again next launch.
 */
export class EncryptedFileSecretStore implements SecretStore {
  private readonly fallback = new MemorySecretStore();

  constructor(
    private readonly path: string,
    private readonly encryptor: Encryptor,
    private readonly io: FileIo,
  ) {}

  private async load(): Promise<Record<string, string>> {
    const raw = await this.io.readFile(this.path);
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
    } catch {
      return {};
    }
  }

  async read(key: string): Promise<string | null> {
    if (!this.encryptor.isAvailable()) return this.fallback.read(key);
    const value = (await this.load())[key];
    if (!value) return null;
    try {
      return this.encryptor.decrypt(Buffer.from(value, 'base64'));
    } catch {
      return null; // encrypted by another OS user or corrupted: treat as absent
    }
  }

  async write(key: string, value: string): Promise<void> {
    if (!this.encryptor.isAvailable()) return this.fallback.write(key, value);
    const all = await this.load();
    all[key] = this.encryptor.encrypt(value).toString('base64');
    await this.io.writeFileAtomic(this.path, JSON.stringify(all));
  }

  async remove(key: string): Promise<void> {
    await this.fallback.remove(key);
    const all = await this.load();
    if (!(key in all)) return;
    const remaining = Object.fromEntries(Object.entries(all).filter(([k]) => k !== key));
    await this.io.writeFileAtomic(this.path, JSON.stringify(remaining));
  }
}
