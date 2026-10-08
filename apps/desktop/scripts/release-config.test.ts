// @vitest-environment node
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { loadBuildEnv, releaseProblems } = require('./release-config.cjs') as {
  loadBuildEnv: (dir: string, env?: Record<string, string | undefined>) => Record<string, string>;
  releaseProblems: (config: Record<string, string>) => string[];
};

const RELEASE = {
  MAIN_VITE_API_URL: 'https://api.example.com',
  MAIN_VITE_SIGNALING_URL: 'wss://signal.example.com/ws',
};

describe('release configuration guard', () => {
  it('accepts an https/wss configuration', () => {
    expect(releaseProblems(RELEASE)).toEqual([]);
  });

  it('rejects missing, plain-text, loopback and LAN-test configurations', () => {
    expect(releaseProblems({})).toHaveLength(2);
    expect(releaseProblems({ ...RELEASE, MAIN_VITE_API_URL: 'http://api.example.com' })).toEqual([
      'MAIN_VITE_API_URL must use https://',
    ]);
    expect(
      releaseProblems({ ...RELEASE, MAIN_VITE_SIGNALING_URL: 'wss://localhost:9443/ws' }),
    ).toEqual(['MAIN_VITE_SIGNALING_URL points at this machine (localhost)']);
    expect(releaseProblems({ ...RELEASE, MAIN_VITE_ALLOW_LAN_HTTP: 'true' })).toHaveLength(1);
  });

  it('reads env files in electron-vite order, with the environment winning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kr-env-'));
    writeFileSync(join(dir, '.env'), 'MAIN_VITE_API_URL=http://from-env\n');
    writeFileSync(join(dir, '.env.production'), 'MAIN_VITE_API_URL=https://from-production\n');
    writeFileSync(
      join(dir, '.env.production.local'),
      '# comment\nMAIN_VITE_SIGNALING_URL="wss://local/ws"\n',
    );
    expect(loadBuildEnv(dir, {})).toEqual({
      MAIN_VITE_API_URL: 'https://from-production',
      MAIN_VITE_SIGNALING_URL: 'wss://local/ws',
    });
    expect(loadBuildEnv(dir, { MAIN_VITE_API_URL: 'https://from-shell' }).MAIN_VITE_API_URL).toBe(
      'https://from-shell',
    );
  });
});
