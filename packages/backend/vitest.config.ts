import { defineConfig } from 'vitest/config';

/**
 * unit:        fast, no database (`*.test.ts`).
 * integration: real migrations in embedded Postgres (PGlite), real HTTP /
 *              WebSocket servers on ephemeral ports (`*.int.test.ts`).
 */
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.int.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/**/*.int.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
