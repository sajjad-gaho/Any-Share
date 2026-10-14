# Production deployment (VPS) — guide

> **Status: prepared and tested locally, NOT deployed.** Nothing in this guide
> has been run on a VPS. Do not run it without an explicit go-ahead.

```
                 Internet
   ┌────────────────┼──────────────────────────────┐
   │ 80/443 (TCP), 443/UDP                          │ 3478 UDP/TCP, 5349 TCP, 49152-65535 UDP
   ▼                                                ▼
 Caddy (TLS, Let's Encrypt) ── internal network ──  coturn (host network, own IP/host recommended)
   ├─ https://API_DOMAIN/api/v1/*   → api:8080
   └─ wss://SIGNAL_DOMAIN/ws        → signaling:8081
                         │
                         ▼
                 Supabase (managed): Auth + Postgres
```

Files: `infra/docker/server.Dockerfile`, `infra/deploy/*`, `infra/coturn/*`.

## Shared VPS with an existing nginx (no Caddy)

If nginx (or another web server) already serves other sites on 80/443, do not
start `docker-compose.yml` (its Caddy needs 80/443). Use instead:

- `infra/deploy/docker-compose.nginx.yml`: API and signaling only, published on
  `127.0.0.1:18080` / `127.0.0.1:18081` (loopback, never public).
- `infra/deploy/nginx/kestrel.conf.template`: ONE new nginx site for one host
  name. `https://<host>/api/v1/*` goes to the API, `wss://<host>/ws` to
  signaling, everything else returns 404. It replaces X-Forwarded-For
  (TRUST_PROXY=1) and adds HSTS; the API sets the other security headers.
  The WebSocket map variable is uniquely named, so other sites' maps do not clash.
- Certificates: `certbot --nginx -d <host>` changes only that server block.
- Desktop build: `MAIN_VITE_API_URL=https://<host>`, `MAIN_VITE_SIGNALING_URL=wss://<host>/ws`.

Verified locally (2026-10-08) with nginx 1.26 next to another site:

- `nginx -t` passes.
- API readiness works through the proxy, with the database as `kestrel_api`.
- The WebSocket upgrade and auth both work.
- 100 KB bodies get 413, and unknown paths get 404.
- A spoofed X-Forwarded-For is ignored.
- Each security header appears exactly once.
- The other site is unaffected.

## 1. Prerequisites

- Ubuntu 24.04 LTS VPS (2 vCPU / 2 GB is enough to start), public IPv4.
- A domain with DNS control. A separate small VPS (or at least a separate IP)
  for coturn is recommended: TURN carries relayed media.
- The Supabase project chosen for production (see "Open decisions").

## 2. DNS

| Record            | Type     | Value        |
| ----------------- | -------- | ------------ |
| `api.<domain>`    | A (AAAA) | VPS IP       |
| `signal.<domain>` | A (AAAA) | VPS IP       |
| `turn.<domain>`   | A (AAAA) | TURN host IP |

Create the records before starting Caddy; certificates are issued on first start.

## 3. Firewall

Only these ports are public. Everything else is closed by default.

| Port        | Proto     | Service | Why                                              |
| ----------- | --------- | ------- | ------------------------------------------------ |
| 22          | TCP       | SSH     | Administration: restrict to your IPs, keys only  |
| 80          | TCP       | Caddy   | ACME HTTP-01 challenge, redirect to HTTPS        |
| 443         | TCP + UDP | Caddy   | HTTPS / WSS (UDP for HTTP/3)                     |
| 3478        | UDP + TCP | coturn  | STUN / TURN                                      |
| 5349        | TCP       | coturn  | TURN over TLS (`turns:`), required in production |
| 49152–65535 | UDP       | coturn  | Relay allocations                                |

Never public: 8080/8081 (API/signaling, internal network only), Docker's API,
Postgres (Supabase is managed; the services connect out over TLS).

```bash
ufw default deny incoming && ufw default allow outgoing
ufw allow from <your-ip> to any port 22 proto tcp
ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
# TURN host:
ufw allow 3478 && ufw allow 5349/tcp && ufw allow 49152:65535/udp
ufw enable
```

Docker publishes ports by editing iptables directly; only Caddy publishes ports
in `infra/deploy/docker-compose.yml`, the services use `expose` (internal only).

## 4. Server preparation

```bash
apt update && apt upgrade -y && apt install -y ca-certificates curl unattended-upgrades
# Docker Engine + compose plugin from Docker's apt repository (docs.docker.com/engine/install/ubuntu)
adduser --disabled-password deploy && usermod -aG docker deploy
# SSH: PasswordAuthentication no, PermitRootLogin no
```

## 5. Configuration

```bash
git clone <repo> /opt/kestrel && cd /opt/kestrel/infra/deploy
cp .env.example .env                    # domains, ACME e-mail, image tags
cp server.env.example server.env        # application secrets
chmod 600 server.env
```

`server.env` holds `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DATABASE_URL` (session
pooler, TLS), `STUN_URLS`, `TURN_URLS` (with a `turns:` URL), `TURN_SECRET`.
Compose sets `APP_ENV=production`, hosts, ports and `TRUST_PROXY=1`. Production
start-up refuses: non-https Supabase, database without TLS, TURN without
`turns:`, `RATE_LIMIT_MULTIPLIER > 1`. Errors name the variable, never the value.

Development values cannot leak into production: images contain no `.env`
files (`.dockerignore`), `APP_ENV` is set by compose, and `server.env` is the
only source of secrets.

## 6. Database

1. Production Supabase project decided and verified (project ref).
2. `supabase db push --dry-run` then `supabase db push` for `supabase/migrations`.
3. <a id="database-role"></a>Recommended: switch to `kestrel_api` (migration already applied; see supabase/migrations-pending/README.md),
   set the `kestrel_api` password, use it in `DATABASE_URL`.
4. Supabase dashboard: Auth → enable **leaked password protection**.
5. Supabase dashboard: Auth → Email Templates. The app confirms accounts and
   resets passwords with **codes**, not links, so both templates must show the
   code: in **Confirm signup** and **Reset password** use `{{ .Token }}`
   instead of `{{ .ConfirmationURL }}`. Keep the email OTP length at 6–10
   digits.

## 7. Start

```bash
cd /opt/kestrel/infra/deploy
docker compose build                    # or pull versioned images from CI
docker compose up -d
docker compose ps                       # api + signaling "healthy"
curl -fsS https://api.<domain>/api/v1/health/ready
curl -fsS https://signal.<domain>/health/ready
```

coturn (TURN host):

```bash
cd /opt/kestrel/infra/coturn
mkdir -p secrets certs
printf %s '<same value as TURN_SECRET>' > secrets/turn_secret && chmod 600 secrets/turn_secret
# certs/fullchain.pem + certs/privkey.pem for turn.<domain> (e.g. certbot, renew hook restarts coturn)
TURN_REALM=turn.<domain> TURN_EXTERNAL_IP=<public ip> docker compose -f docker-compose.prod.yml up -d
```

## 8. Health, logs and monitoring

| Check                                      | Meaning                                |
| ------------------------------------------ | -------------------------------------- |
| `GET /api/v1/health`                       | API process alive (no dependencies)    |
| `GET /api/v1/health/ready`                 | API can reach the database             |
| `GET https://signal.<domain>/health`       | Signaling alive                        |
| `GET https://signal.<domain>/health/ready` | Signaling can reach the database       |
| Docker `HEALTHCHECK`                       | Container restarts when liveness fails |

- Logs: JSON on stdout (pino, Caddy), rotated by Docker (`max-size 10m`,
  5 files). Every API response carries `x-request-id` for correlation.
  Passwords, tokens, SDP, ICE candidates and clipboard data are redacted.
- Monitoring (to set up): an external uptime check on both `/health/ready`
  URLs, alerting on 5xx rate and container restarts; Supabase dashboard for
  database load. **Not implemented yet.**

## 9. Backups

| What               | How                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Database           | Supabase daily backups (plan-dependent); enable PITR for production                       |
| Configuration      | `infra/deploy/.env`, `server.env`, coturn `secrets/` in a password manager / secret store |
| Caddy certificates | Volume `caddy_data` (re-issued automatically if lost)                                     |
| Images             | Versioned tags in a registry (`API_IMAGE`, `SIGNALING_IMAGE`)                             |

The services keep no state on disk.

## 10. Updates and rollback

- **Application:** build/pull new tags, set them in `.env`, `docker compose up -d`.
  Rollback = previous tags + `docker compose up -d`.
- **Migrations:** additive only, each with a rollback block; dry run first;
  take a backup before destructive changes (none so far).
- **Caddy / coturn:** pinned versions (`caddy:2.11.7-alpine`, `coturn/coturn:4.6.3`);
  upgrade deliberately, keep the previous tag for rollback.
- **TURN secret rotation:** write the new secret to coturn and `server.env`,
  restart both; credentials issued before expire within `TURN_CREDENTIAL_TTL_SECONDS`.

## 11. Troubleshooting

| Symptom                                     | Check                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Service exits at start with variable names  | Fix those variables in `server.env` (values are never printed)                           |
| `/health/ready` 503                         | Database URL/password, pooler host, TLS (`DATABASE_SSL_CA_FILE` is baked into the image) |
| No certificate                              | DNS points at the VPS, ports 80/443 open, `docker compose logs caddy`                    |
| Clients connect but never see video         | TURN reachable? 3478/5349 + relay UDP range open; `turns:` certificate valid             |
| Many 429 responses                          | Per-IP limits; check `TRUST_PROXY=1` and that traffic really arrives via Caddy           |
| `exec: turnserver: Operation not permitted` | coturn needs `cap_add: NET_BIND_SERVICE` (file capability on the binary)                 |

## 12. Scaling limits

- Signaling keeps connection routing in memory: run exactly **one** instance.
  More instances need a shared bus (e.g. Redis pub/sub) behind `ConnectionRegistry`.
- Rate limiters are in memory per instance (same constraint).
- Measured locally (see docs/phase4-report.md): one API process handled ~1,500
  authenticated requests/s (DB-bound, pool 10); signaling held 480 sockets at
  ~76 MB. These are local numbers, not VPS capacity figures.

## Open decisions before deploying

1. Production Supabase project: a new project, or PBS-DESKTOP after removing test data.
2. Domain names, the VPS provider, the TURN host.
3. Code-signing certificate (Windows installer) and update hosting.
4. Final product name, publisher, icon and appId.
