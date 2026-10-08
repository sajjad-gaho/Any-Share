/**
 * Test-only helpers (`@remote-desktop/backend/testing`). Never import from
 * production code: this module depends on dev dependencies.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { DeviceRecord, Role } from '@remote-desktop/shared';
import { createSupabaseTokenVerifier, type TokenVerifier } from '../auth/token-verifier';
import { createSilentLogger } from '../logger';
import { createLimiters, type Clock, type Limiters } from '../security/rate-limiter';
import { createServices, type Services, type ServiceSettings } from '../services';
import { NO_REQUEST_META } from '../services/context';
import { FakeAuthProvider, TEST_JWT_ISSUER, TEST_JWT_SECRET } from './fake-auth';
import { createTestDb, type TestDb } from './pglite';

export * from './fake-auth';
export * from './pglite';

export interface TestUser {
  id: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

export interface TestDevice {
  record: DeviceRecord;
  privateKey: KeyObject;
  publicKey: string;
  /** Signs `message` with the device's private key (base64 Ed25519 signature). */
  sign(message: string): string;
}

export interface TestHarness {
  db: TestDb;
  services: Services;
  limiters: Limiters;
  authProvider: FakeAuthProvider;
  verifier: TokenVerifier;
  createUser(name?: string): Promise<TestUser>;
  createOrganization(owner: TestUser, slug?: string): Promise<string>;
  addMember(organizationId: string, user: TestUser, role: Role): Promise<void>;
  registerDevice(
    owner: TestUser,
    options?: { organizationId?: string; name?: string },
  ): Promise<TestDevice>;
  close(): Promise<void>;
}

export function generateDeviceKeys(): { privateKey: KeyObject; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

let counter = 0;

export async function createTestHarness(
  options: {
    settings?: Partial<ServiceSettings>;
    rateLimitMultiplier?: number;
    clock?: Clock;
  } = {},
): Promise<TestHarness> {
  const db = await createTestDb();
  const logger = createSilentLogger();
  const limiters = createLimiters(options.rateLimitMultiplier ?? 1000, options.clock);
  const authProvider = new FakeAuthProvider(db);
  const verifier = createSupabaseTokenVerifier({
    issuer: TEST_JWT_ISSUER,
    audience: 'authenticated',
    jwtSecret: TEST_JWT_SECRET,
  });
  const services = createServices(
    {
      db,
      logger,
      limiters,
      settings: {
        connectionRequestTtlSeconds: 60,
        presenceStaleAfterMs: 90_000,
        ...options.settings,
      },
    },
    {
      provider: authProvider,
      verifier,
      options: { checkSessionRevocation: true, sessionCheckCacheMs: 0 },
    },
  );

  const harness: TestHarness = {
    db,
    services,
    limiters,
    authProvider,
    verifier,
    async createUser(name = 'User') {
      counter += 1;
      const email = `${name.toLowerCase().replace(/\W+/g, '-')}-${counter}@example.test`;
      const password = `correct horse ${counter}`;
      const result = await authProvider.signUp({ email, password, displayName: name });
      if (!result.tokens) throw new Error('fake provider always returns tokens');
      return {
        id: result.user.id,
        email,
        password,
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
      };
    },
    async createOrganization(owner, slug) {
      counter += 1;
      const org = await services.organizations.create(owner.id, {
        name: `Org ${counter}`,
        slug: slug ?? `org-${counter}`,
      });
      return org.id;
    },
    async addMember(organizationId, user, role) {
      await db.query(
        `insert into public.organization_members (organization_id, user_id, role)
         values ($1, $2, $3::public.org_role)`,
        [organizationId, user.id, role],
      );
    },
    async registerDevice(owner, deviceOptions = {}) {
      const keys = generateDeviceKeys();
      const record = await services.devices.register(
        owner.id,
        {
          name: deviceOptions.name ?? 'Test PC',
          os: { family: 'windows', version: 'Windows 11' },
          publicKey: keys.publicKey,
          organizationId: deviceOptions.organizationId,
        },
        NO_REQUEST_META,
      );
      return {
        record,
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
        sign: (message) =>
          sign(null, Buffer.from(message, 'utf8'), keys.privateKey).toString('base64'),
      };
    },
    close: () => db.close(),
  };
  return harness;
}
