# Kestrel Remote (working title)

Remote desktop and remote support platform for Windows.

**Current phase: 3 — remote sessions.** Two desktop clients can connect over WebRTC:
screen sharing (multi-monitor, adaptive quality), remote mouse and keyboard, explicit
clipboard transfer and file transfer, all authorized server-side, re-checked on the
remote machine and always visible there ("REMOTE SESSION ACTIVE"). Phase 2's accounts,
organizations, RBAC, RLS, device identity and signaling are the foundation. Audio and
unattended access are not implemented. Not deployed to production.

```bash
pnpm install
pnpm --filter @remote-desktop/windows-helper build   # Rust helper (needs rustup)
pnpm dev:api                                          # HTTP API      (.env.development)
pnpm dev:signaling                                    # WebSocket signaling
pnpm dev                                              # desktop app
```

- [Architecture](docs/architecture.md)
- [Backend: data model, RBAC, RLS, auth, signaling](docs/backend.md)
- [Remote sessions: WebRTC, native helper, security, limitations](docs/phase3.md)
- [STUN/TURN (coturn)](infra/coturn/README.md)
- [Development guide](docs/development.md)
- [Security model and Phase 4 audit](docs/security.md)
- [Production deployment (VPS, Docker, Caddy, firewall, backups)](docs/deployment.md)
- [Windows release build, code signing, auto-update](docs/windows-release.md)
- [Phase 4 report and verification matrix](docs/phase4-report.md) (not production ready: see blockers)
- [Pending database migrations](supabase/migrations-pending/README.md)
