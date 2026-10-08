# apps/signaling

Authenticated WebSocket signaling service (`ws`), endpoint `/ws`, health at `/health`.

Relays connection requests/approvals, WebRTC negotiation (offer, answer, ICE
candidates), session permission updates and session end between a controller and a
remote device, and tracks device presence. It never carries screen, input, clipboard or
file data — and in Phase 2 no client opens a peer connection yet.

Every socket must authenticate within 10 s with a Supabase access token, optionally
proving a device identity by signing a server nonce with the device's Ed25519 key. Every
frame is validated (`@remote-desktop/webrtc`); identities, permissions and session
membership come from the server, never from the message.

```bash
pnpm --filter @remote-desktop/signaling dev
pnpm --filter @remote-desktop/signaling test:integration   # real WebSocket clients
```

Phase 3 additions:

- `session.ice_config` (server → participant): per-user, expiring TURN credentials,
  only after a session is approved.
- `session.verify`: the host re-authorizes every 30 s. The server re-checks the
  controller's access and narrows or ends the session.
- `session.report`: connection progress (CONNECTED / RECONNECTING / FAILED).
- `session.audit`: file and clipboard transfer events (sizes and hashes only).
- Sessions fail when a participant stays disconnected past the grace period; after a
  restart, sessions whose participants don't return are reconciled.

Protocol and presence details: [docs/backend.md](../../docs/backend.md) §9–10 and
[docs/phase3.md](../../docs/phase3.md).
