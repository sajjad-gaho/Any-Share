# Development

## Prerequisites

- Windows 10/11 (macOS/Linux work for UI development; packaging targets Windows)
- Node.js **20.19+** (developed on Node 24)
- pnpm **10** — `npm install -g pnpm@10` (or `corepack enable`)

## First run

```bash
cd remote-desktop
pnpm install          # also downloads the Electron runtime (allowed in pnpm-workspace.yaml)
pnpm dev              # starts electron-vite: Vite dev server + Electron with HMR
```

## Native helper (Rust)

Install Rust with [rustup](https://rustup.rs) (stable, MSVC toolchain) and the Visual
Studio C++ build tools, then `pnpm --filter @remote-desktop/windows-helper build`. The
desktop app uses `native/windows-helper/target/release/kestrel-helper.exe` in development
(debug build as fallback) and bundles it into `resources/` when packaged.

## Two local clients

To try a session on one machine, run two separate instances with their own data folders
(development builds only):

```bash
pnpm --filter @remote-desktop/desktop build
cd apps/desktop
KESTREL_PROFILE=a npx electron .    # sign in, register device -> host
KESTREL_PROFILE=b npx electron .    # sign in, register device, connect to the host's ID
```

Testing both ends on one screen creates a "hall of mirrors" if you control the mouse
while the viewer window shows its own screen; use a second monitor or keep the
pointer outside the viewer when testing input.

## Second PC on the same LAN (test build)

A LAN test lets a second Windows PC use the API and signaling running on this one. It is
**unencrypted** (plain http/ws), so use it only on a trusted home network with test
accounts, and never distribute the installer.

On PC #1 (servers):

1. In the repository's `.env.development` set `API_HOST=0.0.0.0` and
   `SIGNALING_HOST=0.0.0.0`.
2. Allow the ports on the Private network only (admin PowerShell):
   ```powershell
   New-NetFirewallRule -DisplayName "Kestrel LAN test (API+signaling)" -Direction Inbound -Protocol TCP -LocalPort 8080,8081 -Profile Private -RemoteAddress LocalSubnet -Action Allow
   ```
3. Create `apps/desktop/.env.production` with PC #1's LAN address:
   ```
   MAIN_VITE_API_URL=http://192.168.x.y:8080
   MAIN_VITE_SIGNALING_URL=ws://192.168.x.y:8081/ws
   MAIN_VITE_ALLOW_LAN_HTTP=true
   ```
4. Build the helper and the installer: `pnpm --filter @remote-desktop/windows-helper build`,
   then `pnpm --filter @remote-desktop/desktop package:win`.
5. Run `pnpm dev:api` and `pnpm dev:signaling`.

On PC #2, install `apps/desktop/release/Kestrel Remote-Setup-*.exe` (unsigned: SmartScreen
→ More info → Run anyway). Then sign in and register the device. STUN/TURN is not needed
on one LAN.

`MAIN_VITE_ALLOW_LAN_HTTP` only allows private IPv4 addresses (10/8, 172.16/12, 192.168/16).
Public addresses and host names still require https/wss.

Afterwards:

- delete `apps/desktop/.env.production`
- set both hosts back to `127.0.0.1`
- `Remove-NetFirewallRule -DisplayName "Kestrel LAN test (API+signaling)"`
- uninstall the app on PC #2

## Running the backend (Phase 2)

1. `cp .env.development.example .env.development` and fill in `SUPABASE_ANON_KEY` and
   `DATABASE_URL` for project PBS-DESKTOP (`wqomqigjotnkdlheccxl`). See `.env.example`
   for every variable. Never commit these files.
2. Apply the migrations to the project once (see `docs/backend.md` §13).
3. `pnpm dev:api` (port 8080) and `pnpm dev:signaling` (port 8081).
4. `pnpm dev` — the desktop app uses `http://127.0.0.1:8080` in development, or
   `MAIN_VITE_API_URL` from `apps/desktop/.env.development`.

Automated tests need none of this: they run against embedded Postgres.

## Commands (run from the repo root)

| Command                 | What it does                                                         |
| ----------------------- | -------------------------------------------------------------------- |
| `pnpm dev`              | Run the desktop app in development mode                              |
| `pnpm dev:api`          | Run the HTTP API with reload (`apps/api`)                            |
| `pnpm dev:signaling`    | Run the signaling service with reload (`apps/signaling`)             |
| `pnpm typecheck`        | `tsc --noEmit` in every package (Turborepo)                          |
| `pnpm lint`             | ESLint over the whole repo, zero warnings allowed                    |
| `pnpm format`           | Prettier write                                                       |
| `pnpm format:check`     | Prettier check                                                       |
| `pnpm test`             | Unit tests in every package (Turborepo)                              |
| `pnpm test:integration` | Integration tests: migrations + RLS in PGlite, API, WebSocket server |
| `pnpm check`            | typecheck + lint + format:check + test + test:integration            |
| `pnpm build`            | Desktop app into `apps/desktop/out/`, servers into `apps/*/dist/`    |
| `pnpm package:win`      | Build + NSIS installer into `apps/desktop/release/`                  |

Desktop-only extras (`pnpm --filter @remote-desktop/desktop <script>`):

| Script        | What it does                                                         |
| ------------- | -------------------------------------------------------------------- |
| `preview`     | Run the production build in Electron without packaging               |
| `package:dir` | Build an unpacked app (`release/win-unpacked/`) — fastest to inspect |

## Conventions

- **TypeScript:** strict, plus `noUncheckedIndexedAccess`, `noImplicitReturns`,
  `verbatimModuleSyntax`. No `any`, no non-null assertions.
- **Shared types** come from Zod schemas in `packages/shared`. Never redeclare a domain
  type inside an app.
- **Validation at boundaries:** user input (forms), IPC arguments (main process) and
  persisted state (`localStorage`) are always parsed with Zod.
- **Renderer imports:** never `electron` or Node modules — ESLint fails the build. Add a
  narrow IPC method instead (see `docs/architecture.md` §3).
- **Unfinished features:** add/keep an entry in `FEATURES` (`packages/shared/src/features.ts`)
  with `status: 'planned'`, reference it from the UI (`PlannedBadge`, planned setting row
  or `ViewerToolbarButton`), and leave a `TODO(phase-N)` comment where the real
  implementation will go. Do not simulate behaviour.
- **UI primitives** go in `packages/ui` (shadcn/ui-style: copy-in components on Radix, styled
  with semantic tokens). App-specific composites go in
  `apps/desktop/src/renderer/src/components`.
- **Branding** is a placeholder (`BRAND` in `packages/shared/src/brand.ts`, `LogoMark` in
  `packages/ui`, `productName`/`appId` in `electron-builder.yml`).

## Adding an IPC method

1. Add the channel and method signature to `apps/desktop/src/shared/ipc.ts`.
2. Register it in `apps/desktop/src/main/ipc.ts` with `handle(channel, z.tuple([...]), fn)`.
3. Expose it in `apps/desktop/src/preload/preload.ts`.
4. Call it from the renderer via `getDesktopApi()` (handles the non-Electron case).

## Testing

- Unit tests sit next to the code as `*.test.ts`; integration tests as `*.int.test.ts`
  (`packages/backend`, `apps/api`, `apps/signaling`).
- Integration tests build a fresh in-memory Postgres per suite from
  `supabase/tests/supabase-shim.sql` + `supabase/migrations/*.sql`
  (`@remote-desktop/backend/testing`), with a fake Supabase Auth that issues real JWTs.
- `packages/*` and server tests run in Node; `apps/desktop` tests run in jsdom
  (`apps/desktop/vitest.config.ts`), except main-process tests (`// @vitest-environment node`).
- Run one package: `pnpm --filter @remote-desktop/shared test`.
- Watch mode: `pnpm --filter @remote-desktop/desktop exec vitest`.

## Backend conventions

- **Identity comes from the verified token** (`request.auth`, the authenticated socket),
  never from a body, query or message field. Roles come from the database.
- **Authorization lives in the services** (`packages/backend/src/services`); routes and
  signaling handlers only validate input and translate errors.
- **Reads on behalf of a user use `asUser`** so RLS applies; privileged writes come only
  after a service check.
- **Answer 404, not 403,** for resources the caller may not see.
- **Never log or audit secrets or user content.** Audit metadata passes through
  `sanitizeAuditMetadata`; pino redacts known sensitive fields.
- **The Electron app gets public configuration only** (the API URL). Server code
  (`@remote-desktop/backend`) cannot be imported from the desktop app or shared
  packages; ESLint enforces it.

## Troubleshooting

- **`Electron failed to install correctly`** — the postinstall was skipped. Run
  `pnpm rebuild electron`.
- **Blank window in dev** — check the terminal for Vite errors; the renderer URL comes from
  `ELECTRON_RENDERER_URL`, which electron-vite sets automatically.
- **Packaging is slow the first time** — electron-builder downloads the Electron and NSIS
  binaries once and caches them in `%LOCALAPPDATA%\electron-builder\Cache`.
