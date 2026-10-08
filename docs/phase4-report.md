# Phase 4 report: production hardening (2026-10-08)

## Verdict

**NOT PRODUCTION READY: BLOCKERS REMAIN.** The code, the containers and the
configuration are hardened and were tested locally, but nothing was deployed.
Infrastructure-dependent items (real domain, TLS from a public CA, TURN across
networks, code signing, monitoring) are unverified.

Labels: **LOCAL** = verified locally (manual/live), **AUTO** = verified by
automated tests, **CONFIG** = configuration prepared but not externally tested,
**EXTERNAL** = requires VPS / domain / external infrastructure,
**NOT IMPL** = not implemented, **BLOCKED** = cannot proceed without a decision/resource.

## Verification matrix

| Area                                      | Result                                                                                                                                               | Label                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Authentication                            | JWT (JWKS/ES256) verification, revocation check, WS re-check every 60 s                                                                              | AUTO + LOCAL                              |
| Authorization / RBAC                      | Existing Phase 2/3 tests (68 + 36) still pass                                                                                                        | AUTO                                      |
| RLS                                       | Enabled on all 10 tables; advisor: no missing policies (device_credentials deny-all by design)                                                       | AUTO + LOCAL (advisor)                    |
| Organization / device / session isolation | RLS + service tests                                                                                                                                  | AUTO                                      |
| Least-privilege DB role                   | Prepared (pending migration); allowed/denied statements tested on PGlite and local Supabase PG 17; all service flows ran as `kestrel_api` under load | AUTO + LOCAL (not applied to PBS-DESKTOP) |
| IPC security                              | Sender + schema validation (existing); no menu/DevTools when packaged; debug switches refused                                                        | AUTO + LOCAL                              |
| WebSocket security                        | Auth timeout, size/rate limits, per-message authz, sign-in re-check, flood → closed in 76 ms, 171/200 upgrade attempts refused                       | AUTO + LOCAL                              |
| WebRTC / TURN security                    | Credentials only after approval; prod coturn: TLS 1.3, bad/expired credentials refused, private/loopback peers 403                                   | AUTO + LOCAL (Docker)                     |
| File transfer / clipboard / input         | Existing Phase 3 tests; Electron 44 regression: 300 KB byte-exact, clipboard both ways, cursor exact                                                 | AUTO + LOCAL                              |
| Secrets                                   | Not in images (inspected), not on command lines (coturn), `.dockerignore`/`.gitignore` hardened                                                      | LOCAL                                     |
| Rate limiting                             | Per-IP limit engaged under load (429 at budget); production cannot loosen it                                                                         | AUTO + LOCAL                              |
| Validation / error sanitization           | 413 at proxy, 401 without details, no stack traces                                                                                                   | AUTO + LOCAL                              |
| Electron 44 upgrade                       | Typecheck, tests, live two-client session                                                                                                            | AUTO + LOCAL                              |
| Electron fuses                            | Applied + read back on every build; packaged exe tested (debug switches, NODE_OPTIONS, RUN_AS_NODE)                                                  | LOCAL                                     |
| Docker images                             | Built; non-root; read-only app dir; healthchecks                                                                                                     | LOCAL                                     |
| Docker compose stack                      | Caddy + API + signaling healthy; only Caddy published                                                                                                | LOCAL                                     |
| Caddy / HTTPS                             | Local CA: TLS 1.3, TLS 1.1 refused, HSTS/CSP/XFO, WSS upgrade, XFF spoof ignored; Electron E2E through it                                            | LOCAL (Let's Encrypt: EXTERNAL)           |
| coturn production                         | Config + compose + secret handling tested in Docker                                                                                                  | LOCAL (public relay: EXTERNAL)            |
| Firewall                                  | Plan documented (docs/deployment.md §3)                                                                                                              | CONFIG                                    |
| DNS                                       | Records documented                                                                                                                                   | EXTERNAL                                  |
| Health checks                             | `/api/v1/health(/ready)`, signaling `/health(/ready)`, Docker HEALTHCHECK                                                                            | AUTO + LOCAL                              |
| Logging                                   | JSON, redaction, request ids, rotation                                                                                                               | AUTO + LOCAL                              |
| Monitoring / alerting                     | Documented only                                                                                                                                      | NOT IMPL                                  |
| Windows build / installer                 | Packaged with fuses + release guard; metadata/icon placeholders                                                                                      | LOCAL                                     |
| Code signing                              | Configuration skeleton only                                                                                                                          | NOT IMPL (requires certificate)           |
| Auto-update                               | Design documented                                                                                                                                    | NOT IMPL (requires signing + HTTPS feed)  |
| Two-client test (same PC)                 | Passed on Electron 44, direct and through the Docker/Caddy stack                                                                                     | LOCAL                                     |
| Two-PC LAN test                           | Done in Phase 3 follow-up (LAN build, approval flow)                                                                                                 | LOCAL                                     |
| Different-network test                    | Not possible without public infrastructure                                                                                                           | EXTERNAL                                  |
| TURN fallback across NAT                  | Forced-relay test on one machine (Phase 3); not across real NATs                                                                                     | EXTERNAL                                  |
| Multi-monitor                             | Logic tests only (one monitor available)                                                                                                             | BLOCKED (hardware)                        |
| Reconnect / permission denial             | Existing tests + Phase 3 live tests                                                                                                                  | AUTO + LOCAL                              |
| Load / stress                             | Measured locally (below)                                                                                                                             | LOCAL                                     |
| Dependency audit                          | 32 → 2 advisories (both build-time only, no fix available)                                                                                           | LOCAL                                     |

## Test totals (2026-10-08)

- Unit: 210 (shared 44, webrtc 25, security 15, backend 18, signaling 3, desktop 85, api 5, Rust 15)
- Integration: 142 (backend 75, signaling 36, api 31)
- Typecheck 9/9, ESLint, Prettier, clippy `-D warnings`, rustfmt: clean.
- New in Phase 4: 27 tests (API 5: proxy IP, headers, health aliases; signaling 7:
  sign-in re-check, readiness, client IP; security 3: UNC navigation, debug
  switches; desktop 3: release guard; backend 9: config rules, pending
  migrations / least-privilege role).

## Load / stress (measured locally)

Setup: Windows 11, i5-12400, API/signaling production bundles as single Node 24
processes, **local** Supabase (Docker, Postgres 17), services connected as
`kestrel_api`, pool max 10, autocannon 50 connections. Load generator, servers
and database on the same machine. **Not VPS capacity figures.**

| Test                                                   | Result                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `GET /api/v1/health` (60k requests)                    | 15,000 req/s, p50 2 ms, p99 8 ms, 0 errors                                                      |
| `GET /api/v1/health/ready` (DB, 60k)                   | 6,667 req/s, p50 7 ms, p99 10 ms, 0 errors                                                      |
| `GET /api/v1/devices` (JWT + RLS transaction, 60k)     | 1,500 req/s, p50 32 ms, p99 38 ms, 0 errors                                                     |
| Per-IP limit under sustained load                      | Requests beyond the budget answered 429 (limiter works)                                         |
| 480 concurrent authenticated WebSockets                | 0 failures, auth p50 35 ms / p99 124 ms; signaling RSS 61 → 76 MB                               |
| Two rounds of 480 sockets open/close                   | RSS 76 → 77 → 81 MB (inconclusive; a soak test is needed)                                       |
| 200 sessions created + ended (40 parallel controllers) | 0 errors, ~307 sessions/s, request ack p99 116 ms, end p99 44 ms; DB: 200 ENDED, 640 audit rows |
| Message flood on one socket (production limits)        | Closed with 4008 after 76 ms                                                                    |
| 200 upgrade attempts from one IP                       | 29 accepted, 171 refused (429)                                                                  |

Bottlenecks identified: authenticated API requests are database-bound (one RLS
transaction per request, pool 10); signaling and rate limits are single-instance
in memory. TURN capacity was not measured (needs real relay traffic and
bandwidth); it scales with host bandwidth, so plan a dedicated host.

## Remaining blockers

1. Test-data decision for PBS-DESKTOP (chosen as production, F13); `kestrel_api` password + `DATABASE_URL` switch.
2. Domain + DNS + VPS; first real deployment and Let's Encrypt certificates.
3. TURN host with a public IP; different-network tests.
4. Code-signing certificate; then auto-update.
5. Branding (name, publisher, icon, appId).
6. Monitoring and alerting.
7. Multi-monitor live test (hardware).
8. Supabase dashboard: leaked-password protection.

## Exact next steps

1. Decide the production Supabase project and the domain names.
2. Approve switching `DATABASE_URL` to `kestrel_api` (migrations applied 2026-10-08).
3. Provision the VPS and TURN host; follow docs/deployment.md.
4. Run the different-network and TURN tests against the deployed stack.
5. Obtain a signing certificate (Azure Trusted Signing recommended), enable
   signing, then implement auto-update per docs/windows-release.md.
6. Add uptime monitoring and alerting; run a multi-hour soak test.
