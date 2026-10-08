# Security model

Kestrel Remote is an attended remote-support tool: the remote user always
approves (or explicitly grants) access, always sees an active session and can
end it at any time. There is no stealth mode, persistence or unattended access.

## Trust boundaries

```
 Renderer (sandboxed web page)  ──IPC (allowlist, zod, sender check)──▶  Electron main
                                                                          │ stdio, fixed command set
                                                                          ▼
                                                                      Rust helper (SendInput, capture, clipboard)
 Electron main ──HTTPS──▶ Caddy ──▶ API ───────┐
 Electron main ──WSS────▶ Caddy ──▶ signaling ─┴──▶ Supabase (Auth + Postgres, RLS)
 Peer ◀═══ WebRTC DTLS-SRTP + SCTP (direct or via TURN, end-to-end encrypted) ═══▶ Peer
```

| Boundary            | Controls                                                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer → main     | `sandbox`, `contextIsolation`, no Node; one preload API; every channel validated with zod; sender must be our own top-level page; session-owner window checks                                                           |
| Main → helper       | No sockets or pipes, only the parent's stdio; fixed commands; all arguments re-validated in Rust; input released on exit                                                                                                |
| Client → API        | Supabase JWT verified locally (JWKS); `auth.sessions` revocation check; identity only from the token; zod on every body; body limit 64 KiB; per-IP and per-account rate limits; sanitized errors; no CORS               |
| Client → signaling  | JWT + single-use nonce + Ed25519 device proof; 10 s auth timeout; frame size and message rate limits; every relay message authorized against the database; **sign-in re-checked every 60 s** (logout closes the socket) |
| Services → database | RLS on every table; `asUser` for user-scoped reads; prepared least-privilege role `kestrel_api` (no DDL, append-only audit log, no `auth`/`vault` access)                                                               |
| Peer ↔ peer         | Only after server-side approval; short-lived TURN credentials (HMAC, per user); host re-checks every input, clipboard and file request against server permissions; host re-verifies the session every 30 s              |

## Phase 4 audit: findings and status

| #   | Finding                                                                                    | Severity | Status                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Electron 38.8.6 out of support, 24 advisories                                              | High     | **Fixed:** Electron 44.7.0; live two-client regression passed                                                                                                             |
| F2  | Packaged app accepted `--remote-debugging-port` / `--inspect`; no fuses                    | Medium   | **Fixed:** start-up guard (`packages/security/src/launch.ts`) + fuses (RunAsNode, NODE_OPTIONS, inspect off; asar integrity + asar-only on); verified on the packaged exe |
| F3  | `TRUST_PROXY=true` trusted any X-Forwarded-For; signaling used the client-controlled entry | Medium   | **Fixed:** hop count; address taken from the right; Caddy replaces the header; spoofing tested through the Docker stack                                                   |
| F4  | WebSocket auth checked once; logout left sockets open until token expiry                   | Medium   | **Fixed:** 60 s re-check, socket closed with "Signed out"; integration test                                                                                               |
| F5  | Services use the `postgres` DB role (bypasses RLS, can change schema)                      | Medium   | **Applied 2026-10-08** (`20261008000200_api_role`): role exists without a password; services still use `postgres` until the `DATABASE_URL` switch is approved             |
| F6  | DevTools / menu accelerators in packaged builds                                            | Low–Med  | **Fixed:** no application menu, `devTools: !app.isPackaged`                                                                                                               |
| F7  | `file:` navigation check ignored the host (UNC → NTLM leak)                                | Low      | **Fixed** + test                                                                                                                                                          |
| F8  | API: no timeouts, partial headers, no `/api/v1/health`, no request id                      | Low      | **Fixed** + tests                                                                                                                                                         |
| F9  | Signaling `/health` exposed the connection count                                           | Low      | **Fixed:** status only; `/health/ready` added                                                                                                                             |
| F10 | Leaked-password protection off; 7 unindexed foreign keys                                   | Info     | Indexes **applied 2026-10-08** (`20261008000100_fk_indexes`); leaked-password protection is a dashboard setting (**open**)                                                |
| F11 | Dev tooling vulnerabilities (vitest / tinypool)                                            | Info     | **Fixed:** vitest 4.1.11. Two remaining build-time-only advisories in electron-builder's download tooling (no patched version; not shipped)                               |
| F12 | LAN `http` installer in `release/`; placeholder metadata; no signing or auto-update        | Config   | LAN installer **deleted**; **release guard** refuses non-https/wss builds; signing and auto-update **not implemented** (require a certificate)                            |
| F13 | One Supabase project for development and production, holding test data                     | Data     | **Open:** decide on a separate production project or a clean-up                                                                                                           |

Also changed: built apps no longer show sample data by default (it looked like
real machines).

## Electron fuses

Applied by `apps/desktop/scripts/after-pack.cjs` → `flip-fuses.cjs` (child
process; read back and verified on every build):

| Fuse                                  | Value  | Why                                                                                                                                                                    |
| ------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RunAsNode                             | off    | `ELECTRON_RUN_AS_NODE` must not turn the app into a Node runtime                                                                                                       |
| EnableNodeOptionsEnvironmentVariable  | off    | `NODE_OPTIONS=--require/--inspect` ignored                                                                                                                             |
| EnableNodeCliInspectArguments         | off    | `--inspect` ignored                                                                                                                                                    |
| EnableEmbeddedAsarIntegrityValidation | on     | Modified `app.asar` refuses to load                                                                                                                                    |
| OnlyLoadAppFromAsar                   | on     | No loose-file app directory                                                                                                                                            |
| EnableCookieEncryption                | on     | Cookies encrypted with DPAPI                                                                                                                                           |
| GrantFileProtocolExtraPrivileges      | **on** | Required while the renderer loads from `file://` inside app.asar (off → `ERR_FILE_NOT_FOUND`). Turning it off needs a custom `app://` protocol (recommended follow-up) |

## Secrets

| Secret                    | Where it lives                                                    | Never in                        |
| ------------------------- | ----------------------------------------------------------------- | ------------------------------- |
| `DATABASE_URL` (password) | `infra/deploy/server.env` on the server (chmod 600)               | images, repo, logs, Electron    |
| `TURN_SECRET`             | `server.env` + `infra/coturn/secrets/turn_secret` (Docker secret) | command lines, images, repo     |
| Supabase service-role key | not used anywhere                                                 | everywhere                      |
| Device private key        | Electron main, encrypted with `safeStorage` (DPAPI)               | renderer, server                |
| Access/refresh tokens     | Electron main (encrypted); verified by servers                    | renderer, logs (pino redaction) |
| Code-signing key (future) | HSM / Azure Trusted Signing                                       | repo, CI variables as a file    |

`.dockerignore` excludes every `.env*` file; the images were inspected and
contain no `.env` file and no secret-looking strings.

## Residual risks (accepted or open)

- Two build-time-only advisories (`http-cache-semantics`, `sprintf-js`) in
  electron-builder's Electron download tooling; no fixed version exists.
- `GrantFileProtocolExtraPrivileges` stays on until a custom protocol is added.
- Signaling routing is in memory: one instance only (no horizontal scaling).
- The same Windows user's malware can still inject input into the app window
  like into any other window (UIPI applies; no elevation).
- Unsigned builds: SmartScreen warnings; no safe auto-update until signed.
