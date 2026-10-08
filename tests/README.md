# tests

Tests live next to the code they cover:

- `*.test.ts` — unit tests (`pnpm test`).
- `*.int.test.ts` — integration tests (`pnpm test:integration`): the real SQL migrations
  in embedded Postgres (PGlite), RLS exercised as the `authenticated`/`anon` roles, the
  Fastify app via `inject`, and the signaling server with real WebSocket clients. No
  network access or Supabase project is needed.

Planned: Playwright for Electron UI flows.
