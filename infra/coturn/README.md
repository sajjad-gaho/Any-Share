# coturn (STUN / TURN)

Screen video, input and files flow **peer to peer** over WebRTC
(DTLS-SRTP / SCTP). The servers only help the peers find each other:

| Role           | What it does                                                                                            | Sees media?            |
| -------------- | ------------------------------------------------------------------------------------------------------- | ---------------------- |
| **STUN**       | Tells a peer its public address (NAT discovery).                                                        | No                     |
| **TURN**       | Relays the encrypted media when no direct path exists (symmetric NAT, strict firewalls). Fallback only. | Only encrypted packets |
| apps/signaling | Exchanges offers/answers/ICE candidates, after authorization.                                           | No                     |

ICE tries host (LAN), then server-reflexive (STUN), then relayed (TURN)
candidates and picks the best working pair automatically.

## Credentials (short-lived, per user)

coturn runs in **shared-secret mode** (`use-auth-secret`, the "TURN REST API"):

1. coturn and apps/signaling share `TURN_SECRET` (never sent to clients).
2. Only after a session is **approved**, the signaling server sends each
   participant `session.ice_config` with:
   - username `"<expiry unix seconds>:<user id>"`
   - password `base64(HMAC-SHA1(TURN_SECRET, username))`
3. coturn recomputes the HMAC and refuses expired usernames.
4. Credentials last `TURN_CREDENTIAL_TTL_SECONDS` (default 1 h); host sessions
   receive fresh ones with every 30 s `session.verify`.

Knowing a device ID gives no TURN access: credentials exist only for
authorized sessions. No static TURN users are configured anywhere.

## Ports

| Port                                   | Protocol  | Purpose                                                                |
| -------------------------------------- | --------- | ---------------------------------------------------------------------- |
| 3478                                   | UDP + TCP | STUN and TURN                                                          |
| 5349                                   | TCP (TLS) | TURN over TLS (`turns:`) — production                                  |
| 443 (optional)                         | TCP (TLS) | TURN over TLS through restrictive firewalls (`alt-tls-listening-port`) |
| 49160–49200 (dev) / 49152–65535 (prod) | UDP       | Relay allocations                                                      |

## Local / private-network testing

Two clients on the same machine or LAN connect **directly** with host
candidates; no STUN/TURN is needed. That is the default when `STUN_URLS` /
`TURN_URLS` are empty.

To exercise TURN locally (needs Docker with virtualization enabled):

```bash
cd infra/coturn
cp .env.example .env            # set TURN_SECRET
docker compose up
```

Then in the repository's `.env.development`:

```
STUN_URLS=stun:127.0.0.1:3478
TURN_URLS=turn:127.0.0.1:3478?transport=udp,turn:127.0.0.1:3478?transport=tcp
TURN_SECRET=<same value as infra/coturn/.env>
```

and restart `pnpm dev:signaling`. The viewer shows a **TURN relay** badge when
traffic is relayed.

## TLS considerations (production)

- Offer `turns:` (TLS on 5349, ideally also 443) — the signaling config
  refuses production TURN URLs without at least one `turns:` entry.
- Use a real certificate for the TURN hostname (`cert` / `pkey`); clients
  verify it. Renew it like any web certificate.
- Disable TLS 1.0/1.1 (`no-tlsv1`, `no-tlsv1_1`), keep strong ciphers.
- Media is end-to-end encrypted by WebRTC (DTLS-SRTP) regardless; TLS on
  TURN protects the TURN control channel and helps traverse firewalls.

## Hardening checklist (production)

- `turnserver.prod.conf`: `denied-peer-ip` blocks private, loopback and
  link-local ranges so the relay cannot be abused to reach internal networks.
- Quotas (`user-quota`, `total-quota`, `max-bps`) limit abuse.
- Run on a host with a public IP; set `external-ip` / `relay-ip` correctly.
- Rotate `TURN_SECRET` by updating coturn and apps/signaling together.
- Do not enable `verbose` logging in production.

## Production deployment

`docker-compose.prod.yml` runs `turnserver.prod.conf` with host networking.
`entrypoint.prod.sh` writes the final configuration at start-up from the
template plus the Docker secret `turn_secret` and `TURN_REALM` /
`TURN_EXTERNAL_IP`, so the shared secret never appears on a command line or in
a committed file. The container is read-only, drops all capabilities except
`NET_BIND_SERVICE` (the coturn binary carries that file capability; without it
`exec` fails with "Operation not permitted") and runs with `no-new-privileges`.

Verified locally in Docker (2026-10-08): TLS 1.3 on 5349, valid REST
credentials allocate, wrong or expired credentials are refused, relays to
private and loopback addresses are refused with `403 Forbidden IP`.
Not verified: public relay traffic across real NATs (needs a public host).
See docs/deployment.md for ports and firewall rules.
