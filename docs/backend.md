# Backend (Phase 2)

> Status: **Phase 2 — accounts, authorization, devices, sessions and signaling.**
> No screen capture, input injection, clipboard sync, file transfer or WebRTC media
> exists yet; those are Phase 3. The signaling service relays negotiation messages
> but nothing in the repository opens a peer connection.

```
 Electron renderer ──IPC──▶ Electron main ──HTTPS──▶ apps/api (Fastify) ──┐
   (no tokens)               (tokens, device key)                          ├──▶ Supabase Postgres (RLS)
                             ──WSS (Phase 3 client)──▶ apps/signaling (ws) ─┘    Supabase Auth (GoTrue)
```

| Piece                     | Path                               | Role                                                                                     |
| ------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Migrations                | `supabase/migrations/`             | Schema, triggers, RLS, grants                                                            |
| `@remote-desktop/backend` | `packages/backend/`                | Config, DB access, auth verification, services (all authorization), audit, rate limiting |
| API                       | `apps/api/`                        | REST `/api/v1/*` on top of the services                                                  |
| Signaling                 | `apps/signaling/`                  | Authenticated WebSocket: requests, approvals, WebRTC relay, presence                     |
| Protocol                  | `packages/webrtc/src/signaling.ts` | Zod schemas for every signaling frame                                                    |
| Desktop client            | `apps/desktop/src/main/backend/`   | Session, encrypted secret store, device identity                                         |

## 1. Data model

All tables use UUID primary keys and `timestamptz` columns (`created_at`, `updated_at`
maintained by trigger).

| Table                  | Purpose                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `profiles`             | One per `auth.users` row (created by trigger); display fields only                         |
| `organizations`        | Tenants                                                                                    |
| `organization_members` | `(organization, user, role)`; an organization always keeps ≥ 1 owner (trigger)             |
| `devices`              | Public 9-digit `device_code`, owner, optional organization, presence, `revoked_at`         |
| `device_credentials`   | Ed25519 public key; optional access password as an **Argon2id** hash. Invisible to clients |
| `device_permissions`   | Per-user permission ceiling + `require_approval` on an organization device                 |
| `connection_requests`  | `pending → approved/rejected/expired/cancelled`, max 10-minute lifetime (trigger)          |
| `sessions`             | Session state machine (trigger-enforced), participants immutable                           |
| `session_permissions`  | What was actually granted for one session                                                  |
| `audit_logs`           | Append-only (UPDATE blocked by trigger); no FKs so records outlive their subjects          |

## 2. Roles and permissions

Roles (`org_role`, highest first): **owner, admin, operator, user**. The server always
reads the role from `organization_members`; a role in a request is never trusted.

| Capability                                            | owner |          admin           | operator | user |
| ----------------------------------------------------- | :---: | :----------------------: | :------: | :--: |
| Delete organization                                   |   ✓   |                          |          |      |
| Manage members                                        |   ✓   | ✓ (operators/users only) |          |      |
| Register/manage org devices, grant device permissions |   ✓   |            ✓             |          |      |
| See all org devices, connect                          |   ✓   |            ✓             |    ✓     |      |
| Org audit log                                         |   ✓   |            ✓             |          |      |

Session permissions: `screen_view`, `mouse`, `keyboard`, `clipboard`, `file_transfer`,
`audio`, `remote_control` (+ the `require_approval` flag). Every set must contain
`screen_view`; `mouse`/`keyboard` require `remote_control`.

**Effective access** (`PermissionsService.resolveAccess`), computed from database facts:

1. Device owner → everything, no approval.
2. Organization member with an explicit `device_permissions` row → that row.
3. Otherwise the role ceiling: owner/admin → everything; operator → screen, mouse,
   keyboard, clipboard, remote control; user → nothing. Approval per device setting.
4. Anyone else → no access. **Another user's personal device is never reachable.**

Requests asking for more than the effective access are refused (403); approvals and
mid-session permission updates are intersected with it, so they can only narrow.

## 3. Row level security

Every table has RLS enabled. Client roles only read:

- `anon`: no privileges at all.
- `authenticated`: `SELECT` filtered by policy, plus `UPDATE (display_name, avatar_url)`
  on its own profile. All other writes go through the API.
- `device_credentials`: no grant, no policy — unreadable by every client role.

Policies call `SECURITY DEFINER` helpers in the non-exposed `private` schema
(`is_org_member`, `can_view_device`, `can_manage_device`, …) that take the caller only
from `auth.uid()`. The API's user-facing reads run as `authenticated` with the caller's
claims (`asUser`), so RLS filters them too; privileged writes happen only after the
service layer has authorized them.

## 4. Authentication

Supabase Auth, fronted by `/api/v1/auth/*` so every action is rate-limited, brute-force
protected and audited in one place:

| Endpoint                            | Notes                                                                 |
| ----------------------------------- | --------------------------------------------------------------------- |
| `POST /auth/register`               | Vague error on failure (no account enumeration)                       |
| `POST /auth/login`                  | Lockout per account and per IP, exponential back-off; `LOGIN` audited |
| `POST /auth/refresh`                | Session restoration; Supabase rotates the refresh token               |
| `POST /auth/logout`                 | Revokes the Supabase session; `LOGOUT` audited                        |
| `POST /auth/password-reset`         | Always `202`                                                          |
| `POST /auth/password-reset/confirm` | One-time code from the email + new password; signs out every session  |

Access tokens are verified locally (issuer, audience, expiry, `role=authenticated`) via
the project's JWKS, or the legacy HS256 secret if configured. The token's `session_id`
is checked against `auth.sessions` (15 s cache) so logout takes effect immediately.

> **Supabase setup:** the password-reset flow needs the _Reset Password_ email template
> to include the one-time code (`{{ .Token }}`). Email confirmation may stay enabled; the
> app tells the user to confirm before signing in.

**Desktop:** credentials go renderer → main via IPC; the main process calls the API.
The access token stays in memory; the refresh token is stored encrypted with Electron
`safeStorage` (DPAPI on Windows) — or not stored at all if OS encryption is unavailable.
The renderer only ever sees who is signed in. The app contains no Supabase key; it is
configured with the public API URL only (`MAIN_VITE_API_URL`).

## 5. Device identity

- `device_code`: 8 random digits + Luhn check digit, generated by the server. **Not a
  secret** — knowing it grants nothing.
- Identity: an Ed25519 key pair generated in the desktop main process per account. The
  private key is stored encrypted (safeStorage) and never leaves the process; the server
  stores the public key and its SHA-256 fingerprint (unique among live devices).
- Proof: the signaling service sends each socket a single-use nonce; a device socket
  signs `kestrel-signaling-auth:v1:<nonce>:<deviceId>`. The user must also manage the
  device.
- Optional **access password** (`PATCH /devices/:id { accessPassword }`): hashed with
  Argon2id (m=19 MiB, t=2, p=1). When set, non-owners must supply it with a connection
  request (in addition to their permissions); wrong guesses lock out per (device, user).

## 6. REST API (`/api/v1`, bearer token)

| Method & path                                                            | Purpose                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `GET /users/me`, `PATCH /users/me`                                       | Profile and memberships                                      |
| `GET/POST /organizations`, `GET /organizations/:id`                      | Organizations (creator becomes owner)                        |
| `GET/POST /organizations/:id/members`, `PATCH/DELETE …/members/:userId`  | Membership (RBAC)                                            |
| `GET /devices`, `GET /devices/:id`                                       | Visible devices (RLS)                                        |
| `POST /devices`                                                          | Register (owner = caller; code generated)                    |
| `PATCH /devices/:id`                                                     | Name, tags, organization, approval, access password          |
| `DELETE /devices/:id`                                                    | Revoke: credentials, grants, pending requests, live sessions |
| `GET /devices/:id/access`                                                | Caller's effective access                                    |
| `GET /devices/:id/permissions`, `PUT/DELETE …/permissions/:userId`       | Device permission ceilings                                   |
| `GET /sessions`, `GET /sessions/:id`                                     | Session history                                              |
| `POST /sessions/:id/state`, `POST /sessions/:id/end`                     | Progress reports / end                                       |
| `GET /connection-requests?direction=…`, `GET …/:id`, `POST …/:id/cancel` | Requests                                                     |
| `GET /audit-logs`                                                        | Own entries; organization's for admins                       |
| `GET /health`, `GET /health/ready`                                       | Liveness / database readiness                                |

Unknown or unauthorized resources answer **404** so ids cannot be probed. Errors are
`{ "error": { "code", "message" } }`.

## 7. Session state machine

```
IDLE → REQUESTING → APPROVAL_PENDING → AUTHORIZING → SIGNALING → CONNECTING → CONNECTED
            │               │                             │            ▲  │        │
            └─(no approval needed)─▶ AUTHORIZING          │       RECONNECTING ◀───┘
any live state → ENDING → ENDED     any live state → FAILED     pending/signaling → EXPIRED
```

The table lives in `packages/shared/src/session-state.ts` and in the
`session_transition_allowed` SQL function; a test compares them for all 144 pairs.
Terminal states: `ENDED`, `FAILED`, `EXPIRED`.

## 8. Connection requests

1. Controller → `connection.request { targetDeviceCode, permissions }`.
2. Server resolves access, checks the access password, creates the request (TTL
   `CONNECTION_REQUEST_TTL_SECONDS`, default 60 s) and session (`APPROVAL_PENDING`), and
   pushes `connection.request` to the target device's socket. If no approval is needed it
   goes straight to `SIGNALING`.
3. The remote device socket answers `connection.approve` (optionally fewer permissions) or
   `connection.reject`. Only the target device, operated by a user who manages it, can.
4. Expiry: the signaling sweeper calls `expire_connection_requests()` every 5 s and sends
   `session.end { state: EXPIRED }` to both sides (can also be scheduled with pg_cron).

## 9. Signaling protocol (`/ws`)

Server → client first frame: `auth.challenge { nonce }`. Client must answer within 10 s:

```json
{
  "type": "auth",
  "id": "1",
  "payload": { "accessToken": "…", "device": { "deviceId": "…", "signature": "…" } }
}
```

| Client → server                                           | Server → recipient                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------- |
| `connection.request`                                      | `connection.request` → target device                                       |
| `connection.approve` / `connection.reject`                | same type → controller                                                     |
| `webrtc.offer` / `webrtc.answer` / `webrtc.ice_candidate` | same type → other side (rebuilt from validated fields)                     |
| `session.permission_update`                               | same type → controller                                                     |
| `session.end`                                             | `session.end` → other side                                                 |
| —                                                         | `device.online` / `device.offline` → owner, org admins/operators, grantees |

Every frame is JSON, ≤ 64 KiB, validated by strict Zod schemas (identity fields cannot be
smuggled in). Requests are answered with `ack` or `error` carrying the client's `id`.
`userId`, `deviceId`, permissions and session membership always come from the
authenticated socket and the database; a `sessionId` in a message is only a pointer.
Close codes: 4001 auth timeout, 4002 protocol errors, 4003 auth failed / token expired /
device revoked, 4008 rate limited, 4009 replaced by a newer socket for the same device.

## 10. Presence

WebSocket ping every `HEARTBEAT_INTERVAL_MS` (15 s); a socket that misses a pong is
terminated. `devices.is_online` flips on connect/disconnect; `last_seen_at` is written in
**one batched UPDATE per `PRESENCE_FLUSH_INTERVAL_MS`** (30 s) for all devices that
answered a heartbeat. A device is reported online only if `is_online` and `last_seen_at`
is fresh (3 × flush interval), so a crashed signaling instance cannot leave devices
"online". The flush also disconnects devices revoked through the API.

## 11. Audit log

Actions: `LOGIN`, `LOGOUT`, `DEVICE_REGISTERED`, `DEVICE_REVOKED`,
`CONNECTION_REQUESTED`, `CONNECTION_APPROVED`, `CONNECTION_REJECTED`, `SESSION_STARTED`,
`SESSION_ENDED`, `PERMISSION_CHANGED`. Written in the same transaction as the action.
Metadata is sanitized to flat primitives, and keys that could hold passwords, tokens,
keys, signatures, clipboard/file content or SDP are dropped. Pino redacts the same
fields from logs, plus the `Authorization` header.

## 12. Rate limiting

| What                      | Limit (production)                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| All HTTP routes           | 300/min per IP                                                                           |
| Register / password reset | 5/min per IP                                                                             |
| Login                     | 10/min per IP + lockout after 5 failures per account and per IP (1 min, doubling to 1 h) |
| Password reset confirm    | 5/min per IP + account lockout                                                           |
| Device registration       | 10/hour per user                                                                         |
| Device lookup             | 60/min per user                                                                          |
| Connection requests       | 10/min per user                                                                          |
| Access password guesses   | 5 per 15 min per (device, user), then locked                                             |
| WebSocket connect/auth    | 30/min per IP (failed auth counts double)                                                |
| WebSocket messages        | 120 per 10 s per connection                                                              |

Limiters are in-memory (one instance per service). Scaling out needs a shared store
(e.g. Redis) behind the same interfaces, and a pub/sub bus for signaling routing.

## 13. Applying migrations to Supabase

The migrations target project **PBS-DESKTOP (`wqomqigjotnkdlheccxl`)**. All three were
applied on 2026-10-03 with the Supabase CLI (`supabase link --project-ref
wqomqigjotnkdlheccxl` then `supabase db push`); remote migration history matches local.

For future migrations:

```bash
npx supabase db push --dry-run   # shows what the linked project would receive
npx supabase db push
```

Afterwards run the Supabase security advisor. It reports one INFO, "RLS enabled, no
policy" on `device_credentials`; that is intentional (no client role may read it). If
the database role cannot read `auth.sessions`, the API logs a warning and logout falls
back to token expiry.

**Database TLS:** Supabase's pooler certificate chains to the self-signed
"Supabase Root 2021 CA", committed at `supabase/certs/prod-ca-2021.crt` (public
certificate, SHA-256 `80:70:25:AD:…:CA:FA`, valid to 2031). Set
`DATABASE_SSL_CA_FILE=supabase/certs/prod-ca-2021.crt`; the connection then verifies
against that CA only. Verification is never disabled. Special characters in the
database password must be URL-encoded inside `DATABASE_URL`.
