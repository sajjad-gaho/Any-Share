// @vitest-environment node
import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuthSession } from './auth-session';
import { isPrivateLanHost, resolveApiBaseUrl, resolveSignalingUrl } from './config';
import { DeviceIdentity, osFamilyFor } from './device-identity';
import { ApiError, createHttpClient, type HttpClient, type HttpRequest } from './http';
import { EncryptedFileSecretStore, MemorySecretStore, type Encryptor } from './secret-store';

const USER_ID = '6c1a7c1e-6e2f-4d6a-9a43-3c1d2f0b7a11';
const DEVICE_ID = '41b4c51e-6104-443a-b05a-62640705759c';

function tokens(n: number, expiresInSeconds = 3600) {
  return {
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`,
    expiresAt: Math.floor(Date.now() / 1000) + expiresInSeconds,
  };
}

const me = {
  id: USER_ID,
  email: 'ada@example.test',
  displayName: 'Ada',
  avatarUrl: null,
  createdAt: '2026-10-03T00:00:00.000Z',
  memberships: [],
};

/** Scripted fake of apps/api that records every request. */
class FakeApi implements HttpClient {
  readonly calls: { path: string; accessToken?: string; body?: unknown }[] = [];
  validRefresh = new Set<string>();
  validAccess = new Set<string>();
  issued = 0;
  expiresIn = 3600;
  offline = false;

  private issue() {
    const t = tokens(++this.issued, this.expiresIn);
    this.validAccess.add(t.accessToken);
    this.validRefresh.add(t.refreshToken);
    return { user: { id: USER_ID, email: me.email }, tokens: t };
  }

  async request<T>(req: HttpRequest<T>): Promise<T> {
    this.calls.push({ path: req.path, accessToken: req.accessToken, body: req.body });
    if (this.offline) throw new ApiError(0, 'network', 'offline');
    const body = req.body as Record<string, string> | undefined;
    const respond = (value: unknown) => req.schema.parse(value);
    switch (req.path) {
      case '/api/v1/auth/login':
        if (body?.['password'] !== 'right password') {
          throw new ApiError(401, 'unauthenticated', 'Invalid email or password');
        }
        return respond(this.issue());
      case '/api/v1/auth/refresh': {
        const token = body?.['refreshToken'] ?? '';
        if (!this.validRefresh.delete(token))
          throw new ApiError(401, 'unauthenticated', 'Session expired');
        return respond(this.issue());
      }
      case '/api/v1/auth/logout':
        this.validAccess.delete(req.accessToken ?? '');
        return respond({});
      default:
        if (!req.accessToken || !this.validAccess.has(req.accessToken)) {
          throw new ApiError(401, 'unauthenticated', 'Invalid access token');
        }
        if (req.path === '/api/v1/users/me') return respond(me);
        if (req.path === '/api/v1/devices' && req.method === 'POST') {
          return respond({
            id: DEVICE_ID,
            deviceCode: '123456782',
            name: body?.['name'],
            os: { family: 'windows', version: '11' },
            ownerId: USER_ID,
            organizationId: null,
            tags: [],
            status: 'offline',
            requireApproval: true,
            hasAccessPassword: false,
            keyFingerprint: 'a'.repeat(64),
            lastSeenAt: null,
            revokedAt: null,
            createdAt: '2026-10-03T00:00:00.000Z',
          });
        }
        return respond([]);
    }
  }
}

describe('resolveApiBaseUrl', () => {
  it('defaults to the local API in development only', () => {
    expect(resolveApiBaseUrl(undefined, false)).toBe('http://127.0.0.1:8080');
    expect(resolveApiBaseUrl(undefined, true)).toBeNull();
  });

  it('requires https for packaged builds and remote hosts', () => {
    expect(resolveApiBaseUrl('https://api.example.com/', true)).toBe('https://api.example.com');
    expect(resolveApiBaseUrl('http://api.example.com', false)).toBeNull();
    expect(resolveApiBaseUrl('http://localhost:8080', true)).toBeNull();
    expect(resolveApiBaseUrl('javascript:alert(1)', false)).toBeNull();
  });

  it('rejects plain http to a LAN address unless the build opted in', () => {
    expect(resolveApiBaseUrl('http://192.168.100.249:8080', false)).toBeNull();
    expect(resolveApiBaseUrl('http://192.168.100.249:8080', true)).toBeNull();
    expect(resolveApiBaseUrl('http://192.168.100.249:8080', true, true)).toBe(
      'http://192.168.100.249:8080',
    );
    expect(resolveApiBaseUrl('http://10.0.0.5:8080', false, true)).toBe('http://10.0.0.5:8080');
  });

  it('never allows plain http to public or named hosts, even when opted in', () => {
    for (const url of [
      'http://8.8.8.8:8080',
      'http://172.32.0.1:8080',
      'http://api.example.com',
      'http://192.168.evil.com',
      'http://192.168.1.10.nip.io',
    ]) {
      expect(resolveApiBaseUrl(url, true, true)).toBeNull();
    }
    // Loopback stays development-only.
    expect(resolveApiBaseUrl('http://127.0.0.1:8080', true, true)).toBeNull();
  });
});

describe('resolveSignalingUrl', () => {
  it('follows the same rules for ws', () => {
    expect(resolveSignalingUrl(undefined, false)).toBe('ws://127.0.0.1:8081/ws');
    expect(resolveSignalingUrl(undefined, true)).toBeNull();
    expect(resolveSignalingUrl('wss://signal.example.com/ws', true)).toBe(
      'wss://signal.example.com/ws',
    );
    expect(resolveSignalingUrl('ws://192.168.100.249:8081/ws', true)).toBeNull();
    expect(resolveSignalingUrl('ws://192.168.100.249:8081/ws', true, true)).toBe(
      'ws://192.168.100.249:8081/ws',
    );
    expect(resolveSignalingUrl('ws://signal.example.com/ws', true, true)).toBeNull();
  });
});

describe('isPrivateLanHost', () => {
  it('accepts only RFC 1918 IPv4 addresses', () => {
    for (const host of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1']) {
      expect(isPrivateLanHost(host)).toBe(true);
    }
    for (const host of [
      '172.15.0.1',
      '172.32.0.1',
      '192.169.0.1',
      '8.8.8.8',
      '127.0.0.1',
      '192.168.1.256',
      'localhost',
      '192.168.1.1.example.com',
    ]) {
      expect(isPrivateLanHost(host)).toBe(false);
    }
  });
});

describe('createHttpClient', () => {
  it('maps API errors and validates responses', async () => {
    const fetchImpl = (async (url: string) =>
      url.endsWith('/bad')
        ? new Response(JSON.stringify({ error: { code: 'forbidden', message: 'No' } }), {
            status: 403,
          })
        : new Response(JSON.stringify({ unexpected: true }), {
            status: 200,
          })) as unknown as typeof fetch;
    const http = createHttpClient('https://api.example.com', fetchImpl);
    const { z } = await import('zod');
    await expect(
      http.request({ method: 'GET', path: '/bad', schema: z.unknown() }),
    ).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    await expect(
      http.request({ method: 'GET', path: '/ok', schema: z.object({ id: z.string() }) }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('reports network failures without leaking details', async () => {
    const http = createHttpClient('https://api.example.com', (async () => {
      throw new Error('ECONNREFUSED 10.0.0.1');
    }) as unknown as typeof fetch);
    const { z } = await import('zod');
    await expect(
      http.request({ method: 'GET', path: '/', schema: z.unknown() }),
    ).rejects.toMatchObject({
      code: 'network',
      message: expect.not.stringContaining('10.0.0.1'),
    });
  });
});

describe('EncryptedFileSecretStore', () => {
  const xor: Encryptor = {
    isAvailable: () => true,
    encrypt: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
    decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
  };

  function memoryFs() {
    const files = new Map<string, string>();
    return {
      files,
      readFile: async (path: string) => files.get(path) ?? null,
      writeFileAtomic: async (path: string, data: string) => void files.set(path, data),
    };
  }

  it('never writes secrets in plaintext', async () => {
    const fs = memoryFs();
    const store = new EncryptedFileSecretStore('/secure.json', xor, fs);
    await store.write('auth.refreshToken', 'super-secret-refresh-token');
    expect(fs.files.get('/secure.json')).not.toContain('super-secret-refresh-token');
    expect(await store.read('auth.refreshToken')).toBe('super-secret-refresh-token');
    await store.remove('auth.refreshToken');
    expect(await store.read('auth.refreshToken')).toBeNull();
  });

  it('keeps secrets in memory only when OS encryption is unavailable', async () => {
    const fs = memoryFs();
    const store = new EncryptedFileSecretStore(
      '/secure.json',
      { ...xor, isAvailable: () => false },
      fs,
    );
    await store.write('k', 'v');
    expect(await store.read('k')).toBe('v');
    expect(fs.files.size).toBe(0);
  });

  it('treats corrupted files and undecryptable values as absent', async () => {
    const fs = memoryFs();
    fs.files.set('/secure.json', '{not json');
    const store = new EncryptedFileSecretStore('/secure.json', xor, fs);
    expect(await store.read('k')).toBeNull();
    const failing = new EncryptedFileSecretStore(
      '/secure.json',
      {
        ...xor,
        decrypt: () => {
          throw new Error('wrong user');
        },
      },
      fs,
    );
    fs.files.set('/secure.json', JSON.stringify({ k: 'AAAA' }));
    expect(await failing.read('k')).toBeNull();
  });
});

describe('AuthSession', () => {
  it('logs in, persists only the refresh token, and restores on next launch', async () => {
    const api = new FakeApi();
    const store = new MemorySecretStore();
    const session = new AuthSession(api, store);
    await expect(session.login({ email: me.email, password: 'wrong' })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    const state = await session.login({ email: me.email, password: 'right password' });
    expect(state).toEqual({ status: 'signed-in', user: expect.objectContaining({ id: USER_ID }) });
    expect(JSON.stringify(state)).not.toMatch(/access-|refresh-/);
    expect(await store.read('auth.refreshToken')).toBe('refresh-1');

    const nextLaunch = new AuthSession(api, store);
    expect(await nextLaunch.restore()).toMatchObject({ status: 'signed-in' });
    expect(await store.read('auth.refreshToken')).toBe('refresh-2'); // rotated
  });

  it('discards a rejected saved session but keeps it when offline', async () => {
    const api = new FakeApi();
    const store = new MemorySecretStore();
    await store.write('auth.refreshToken', 'refresh-unknown');
    api.offline = true;
    expect(await new AuthSession(api, store).restore()).toEqual({ status: 'signed-out' });
    expect(await store.read('auth.refreshToken')).toBe('refresh-unknown');
    api.offline = false;
    expect(await new AuthSession(api, store).restore()).toEqual({ status: 'signed-out' });
    expect(await store.read('auth.refreshToken')).toBeNull();
  });

  it('refreshes an expiring token before calling the API, and retries once on 401', async () => {
    const api = new FakeApi();
    api.expiresIn = 30; // inside the refresh margin
    const session = new AuthSession(api, new MemorySecretStore());
    await session.login({ email: me.email, password: 'right password' });
    api.expiresIn = 3600;
    await session.authorized({
      method: 'GET',
      path: '/api/v1/devices',
      schema: (await import('zod')).z.array((await import('zod')).z.unknown()),
    });
    expect(api.calls.at(-1)?.accessToken).toBe('access-2');

    api.validAccess.clear(); // server-side revocation of the access token only
    await session.authorized({
      method: 'GET',
      path: '/api/v1/devices',
      schema: (await import('zod')).z.unknown(),
    });
    expect(api.calls.at(-1)?.accessToken).toBe('access-3');
  });

  it('signs out when the refresh token is rejected', async () => {
    const api = new FakeApi();
    const store = new MemorySecretStore();
    const session = new AuthSession(api, store);
    const changes: string[] = [];
    session.onChange((s) => changes.push(s.status));
    await session.login({ email: me.email, password: 'right password' });
    api.validAccess.clear();
    api.validRefresh.clear();
    await expect(
      session.authorized({
        method: 'GET',
        path: '/api/v1/devices',
        schema: (await import('zod')).z.unknown(),
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(session.getState()).toEqual({ status: 'signed-out' });
    expect(await store.read('auth.refreshToken')).toBeNull();
    expect(changes).toEqual(['signed-in', 'signed-out']);
  });

  it('logs out locally even if the server is unreachable', async () => {
    const api = new FakeApi();
    const store = new MemorySecretStore();
    const session = new AuthSession(api, store);
    await session.login({ email: me.email, password: 'right password' });
    api.offline = true;
    await session.logout();
    expect(session.getState()).toEqual({ status: 'signed-out' });
    expect(await store.read('auth.refreshToken')).toBeNull();
  });
});

describe('DeviceIdentity', () => {
  it('registers with a locally generated Ed25519 key and keeps the private key local', async () => {
    const api = new FakeApi();
    const store = new MemorySecretStore();
    const session = new AuthSession(api, store);
    const identity = new DeviceIdentity(store, session, {
      platform: 'win32',
      release: '10.0.26200',
    });

    await expect(identity.register('PC')).rejects.toMatchObject({ code: 'unauthenticated' });
    await session.login({ email: me.email, password: 'right password' });
    const device = await identity.register('PC');
    expect(device).toEqual({
      deviceId: DEVICE_ID,
      deviceCode: '123456782',
      name: 'PC',
      keyFingerprint: 'a'.repeat(64),
    });

    const sent = api.calls.find((c) => c.path === '/api/v1/devices')?.body as {
      publicKey: string;
      os: { family: string };
    };
    expect(sent.os.family).toBe('windows');
    expect(JSON.stringify(sent)).not.toMatch(/PRIVATE|pkcs8/i);
    const publicKey = createPublicKey({
      key: Buffer.from(sent.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    expect(publicKey.asymmetricKeyType).toBe('ed25519');

    // The stored key signs challenges that verify against the registered public key.
    const signature = await identity.sign('nonce');
    expect(
      verify(null, Buffer.from('nonce'), publicKey, Buffer.from(signature ?? '', 'base64')),
    ).toBe(true);

    // Registering again is idempotent; the record is per account.
    expect(await identity.register('Other name')).toEqual(device);
    expect(await identity.get()).toEqual(device);
    await session.logout();
    expect(await identity.get()).toBeNull();
  });

  it('maps platforms to OS families', () => {
    expect(osFamilyFor('win32')).toBe('windows');
    expect(osFamilyFor('darwin')).toBe('macos');
    expect(osFamilyFor('linux')).toBe('linux');
  });
});
