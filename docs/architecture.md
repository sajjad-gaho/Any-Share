# Architecture

> Status: **Phase 3 — remote sessions** on top of Phase 2's backend. See
> [backend.md](backend.md) (accounts, RBAC, RLS, signaling) and [phase3.md](phase3.md)
> (WebRTC, native helper, input, clipboard, files, security, known limitations).
> Everything that is not implemented is marked as such in code (`FEATURES` registry,
> `TODO(phase-N)` comments) and in the UI ("Planned · Phase N" badges).

## 1. Project structure

```
remote-desktop/
├─ apps/
│  ├─ desktop/            Electron + React client
│  │  ├─ src/main/        Electron main process (privileged, Node.js); backend/ holds the
│  │  │                   API client, session, encrypted secret store, device identity
│  │  ├─ src/preload/     Sandboxed preload; exposes window.desktop via contextBridge
│  │  ├─ src/shared/      IPC contract shared by main, preload and renderer
│  │  └─ src/renderer/    React app (untrusted web content, no Node.js)
│  ├─ api/                HTTP API (Fastify), Phase 2
│  └─ signaling/          WebSocket signaling service (ws), Phase 2
├─ packages/
│  ├─ shared/             Domain types, Zod schemas, device-ID logic, feature registry
│  ├─ security/           RBAC role mapping, navigation allow-listing (pure functions)
│  ├─ backend/            Server-only: config, DB, auth verification, services, audit
│  ├─ webrtc/             Signaling protocol schemas (no peer connection yet)
│  └─ ui/                 Design tokens + shadcn/ui-style primitives on Radix
├─ native/windows-helper/ Rust helper: monitors, DXGI capture, SendInput, clipboard (Phase 3)
├─ supabase/migrations/   Database migrations (schema, triggers, RLS), Phase 2
├─ supabase/tests/        Supabase shim for running migrations in tests
├─ infra/                 Deployment config (planned)
├─ scripts/               build-server.mjs (bundles apps/api and apps/signaling)
├─ tests/                 Notes; tests live next to code (*.test.ts, *.int.test.ts)
└─ docs/
```

### Package boundaries

| Package                      | May depend on                     | Runs in                      |
| ---------------------------- | --------------------------------- | ---------------------------- |
| `@remote-desktop/shared`     | `zod`                             | anywhere                     |
| `@remote-desktop/security`   | `shared`                          | anywhere (pure)              |
| `@remote-desktop/webrtc`     | `shared`, `zod`                   | anywhere                     |
| `@remote-desktop/backend`    | `shared`, `security`, server libs | servers only, never Electron |
| `@remote-desktop/ui`         | React, Radix, Tailwind            | renderer only                |
| `apps/desktop`               | all except `backend`              | Electron                     |
| `apps/api`, `apps/signaling` | `backend`, `shared`, `webrtc`     | Node.js                      |

Workspace packages are **source packages**: their `exports` point at TypeScript files and
consumers (Vite, Vitest, `tsc`) compile them directly. There is no per-package build step,
which keeps type errors and stack traces pointing at real source.

Shared types are **derived from Zod schemas** (`z.infer`) in `packages/shared`, so the
runtime validator and the static type can never drift, and no app redefines them.

| Type                | Schema                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `User`              | `userSchema`                                                                                    |
| `Organization`      | `organizationSchema`                                                                            |
| `Device`            | `deviceSchema`                                                                                  |
| `Session`           | `sessionSchema`                                                                                 |
| `ConnectionRequest` | `connectionRequestSchema`                                                                       |
| `Permission`        | `permissionSchema`                                                                              |
| `AuditLog`          | `auditLogSchema`                                                                                |
| `DeviceId`          | `deviceIdSchema`                                                                                |
| user input          | `profileInputSchema`, `contactInputSchema`, `searchQuerySchema`, `connectionRequestInputSchema` |

### Device IDs

Nine digits: an 8-digit payload plus a **Luhn check digit**. The check digit rejects every
single-digit typo and almost every adjacent transposition _before_ a connection request is
sent. `deviceIdSchema` accepts `123 456 789` / `123-456-789` and outputs the canonical
`123456789`.

## 2. Electron security

The renderer is treated as untrusted web content. The baseline (in
`apps/desktop/src/main/window.ts` and `security.ts`):

| Control                      | Setting                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Context isolation            | `contextIsolation: true`                                                                             |
| Node in renderer             | `nodeIntegration: false` (also in workers and subframes)                                             |
| OS-level sandbox             | `sandbox: true` + `app.enableSandbox()` for all renderers                                            |
| `<webview>`                  | disabled + `will-attach-webview` blocked                                                             |
| Navigation                   | `will-navigate` / `will-redirect` restricted to the app's own URL (`isAllowedNavigation`)            |
| New windows                  | always denied; `https:`/`mailto:` links open in the OS browser                                       |
| Browser permissions          | deny-by-default; only `fullscreen` and sanitized clipboard write                                     |
| Device APIs (HID/USB/serial) | denied                                                                                               |
| Content-Security-Policy      | `script-src 'self'`, no `object`, `frame`, `base-uri` or form actions (dev adds HMR allowances only) |
| Single instance              | `requestSingleInstanceLock()`                                                                        |

ESLint enforces the boundary statically: renderer and `packages/ui` code may not import
`electron`, `node:*`, `fs`, `child_process`, `path`, `os`, `process`, … nor reference
`require` / `process`.

## 3. Renderer / main separation

```
┌────────────────────────┐   window.desktop.*   ┌──────────────┐   ipcRenderer.invoke   ┌──────────────────────┐
│ Renderer (React)       │ ───────────────────▶ │ Preload      │ ─────────────────────▶ │ Main process         │
│ sandboxed, no Node     │                      │ contextBridge│                        │ validates sender +   │
│                        │ ◀─────────────────── │ (frozen API) │ ◀───────────────────── │ args (Zod), executes │
└────────────────────────┘     Promise<result>  └──────────────┘                        └──────────────────────┘
```

- `src/shared/ipc.ts` is the **single contract**: channel names, `DesktopApi` interface,
  payload types. Main, preload and renderer all import it.
- The preload exposes **one method per capability** — never `ipcRenderer`, never a generic
  `invoke(channel, …)`, never Node primitives.
- Every main-process handler goes through `handle()` in `src/main/ipc.ts`, which
  1. rejects calls from any frame other than our top-level renderer URL, and
  2. parses the argument tuple with a Zod schema before the handler sees it.

API surface:

| Method                                                          | Purpose                                         |
| --------------------------------------------------------------- | ----------------------------------------------- |
| `desktop.app.getInfo()`                                         | App name/version, platform, runtime versions    |
| `desktop.theme.setSource(src)`                                  | Sync native chrome with light/dark/system theme |
| `desktop.auth.getState()`                                       | Who is signed in (restores a saved session)     |
| `desktop.auth.login/register/logout()`                          | Account actions; tokens stay in main            |
| `desktop.auth.requestPasswordReset()`, `confirmPasswordReset()` | Password reset by emailed code                  |
| `desktop.auth.verifySignup()`, `resendSignup()`                 | New-account confirmation by emailed code        |
| `desktop.devices.list()`, `sessions.list()`                     | Data from the API as the signed-in user         |
| `desktop.thisDevice.get()`, `register()`                        | This computer's device ID; key pair in main     |

### Renderer architecture

- **Routing:** React Router (hash router, required for `file://`). The viewer
  (`/session/:deviceId`) is a full-window route outside the main shell.
- **State:** Zustand.
  - `createCollectionStore()` — generic async collection (idle/loading/success/error,
    latest-request-wins) used for devices and sessions.
  - `settings`, `theme`, `address-book` — persisted to `localStorage`; persisted data is
    re-validated with Zod on load (`validatedMerge`), so corrupt/tampered values are dropped.
  - `viewer` — viewer session state; its shape is what the Phase 2 session controller
    will drive. In Phase 1 it can never report "connected".
- **Data access:** pages depend on `DeviceRepository` / `SessionRepository` interfaces.
  Signed in, the API repository is used (via main-process IPC). Signed out, a _preview_
  repository returns a clearly labelled sample dataset (toggle in Settings → General).
- **Forms:** React Hook Form + `zodResolver` with the shared schemas.
- **Design system:** semantic CSS custom-property tokens (`packages/ui/src/styles/tokens.css`)
  mapped into Tailwind v4 via `@theme inline`; dark mode is a `.dark` class on `<html>`.

### Honesty rules for unfinished work

- `FEATURES` in `packages/shared/src/features.ts` lists every capability with
  `status: 'available' | 'planned'` and its phase.
- UI for a planned feature must reference its key: `<PlannedBadge feature=… />`, planned
  setting rows (disabled, stateless) or `ViewerToolbarButton` (aria-disabled with an
  explanatory tooltip).
- Sample data is always accompanied by `<SampleDataNotice />`.

## 4. WebRTC architecture (implemented in Phase 3 — details in phase3.md)

```
 Viewer (Electron)                       Signaling (WSS)                     Host (Electron + Rust helper)
 ───────────────────                     ───────────────                     ─────────────────────────────
 connect-request ───────────────────────▶ authz + relay ───────────────────▶ prompt user / policy check
                 ◀─────────────────────── connect-response ◀──────────────── accept + granted permissions
 sdp-offer       ───────────────────────▶ relay ───────────────────────────▶
                 ◀─────────────────────── sdp-answer ◀─────────────────────
 ice-candidate   ◀──────────────────────▶ relay ◀──────────────────────────▶ ice-candidate

            ════════════ DTLS-SRTP / SCTP (direct, or via TURN relay) ════════════
 video track     ◀─────────────────────────────────────────────────────────── screen (from helper)
 "input" DC      ───────────────────────────────────────────────────────────▶ SendInput (helper)
 "clipboard" DC  ◀──────────────────────────────────────────────────────────▶
 "file-transfer" ◀──────────────────────────────────────────────────────────▶
 "control" DC    ◀──────────────────────────────────────────────────────────▶ monitor switch, quality
```

- The signaling service and its validated protocol exist (Phase 2, see
  [backend.md](backend.md) §9: `connection.*`, `webrtc.*`, `session.*`, `device.*`).
  The desktop signaling client and the peer connection are Phase 3.
- The session controller will live in the renderer (WebRTC is a browser API) and update
  `useViewerStore`; privileged work (capture, injection) is requested from main over new,
  narrowly-scoped IPC methods.
- The host enforces granted `SessionPermission`s on every data-channel message — the
  viewer's UI state is never trusted.
- STUN for discovery; TURN (coturn) with short-lived credentials issued by `apps/api`.
- Signaling authenticates every socket and authorises every `connect-request` against
  Supabase (RBAC, device ownership) and writes audit-log entries.

## 5. Rust architecture (implemented in Phase 3; the original design notes below

were followed except that the helper talks over stdio instead of a named pipe)

`native/windows-helper` will be a separate Rust process — not a Node native addon — so
that a crash in capture/injection code cannot take down Electron, and so it can later run
as a Windows service for unattended access.

```
Electron main ──spawn──▶ windows-helper.exe
      │  named pipe (per-session random name, ACL'd to the current user)
      │  length-prefixed, versioned messages (serde, bincode/CBOR)
      ▼
 ┌───────────────────────────────────────────────┐
 │ capture  : DXGI Desktop Duplication per output│
 │ encode   : hand frames to Chromium (shared tex │
 │            or raw BGRA) — encoder TBD           │
 │ input    : SendInput (mouse, keyboard, scroll) │
 │ monitors : EnumDisplayMonitors + DPI           │
 │ service  : (later) secure desktop, lock, blank │
 └───────────────────────────────────────────────┘
```

- Only the main process talks to the helper; the renderer reaches it through specific
  IPC methods with validated arguments.
- Input events from a remote peer are checked against the session's granted permissions
  in main **and** in the helper.
- The helper binary will be code-signed alongside the Electron app.
