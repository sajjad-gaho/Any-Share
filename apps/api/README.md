# apps/api

HTTP API (Node.js, TypeScript, **Fastify**, **Zod**, **Pino**) under `/api/v1`.

Modules (`src/routes/`): `auth`, `users`, `organizations`, `devices`, `permissions`,
`sessions`, `connection-requests`, `audit`, `health`. Routes are thin: they validate
input with the shared Zod schemas, take the caller from the verified bearer token, and
call the services in `@remote-desktop/backend`, which do all authorization.

```bash
pnpm --filter @remote-desktop/api dev               # tsx watch, reads .env.development
pnpm --filter @remote-desktop/api build             # bundle to dist/main.js
pnpm --filter @remote-desktop/api test              # unit
pnpm --filter @remote-desktop/api test:integration  # app.inject against real migrations (PGlite)
```

See [docs/backend.md](../../docs/backend.md) for the endpoint list and security model.
