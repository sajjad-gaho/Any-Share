#!/bin/sh
# Builds the final coturn configuration at start-up so that secrets never
# appear on a command line (visible to every local user via /proc/*/cmdline)
# and never in a committed file:
#
#   /etc/coturn/turnserver.conf      template (read-only, from this repo)
#   /run/secrets/turn_secret         static-auth-secret (Docker secret)
#   TURN_REALM / TURN_EXTERNAL_IP    environment (not secret)
set -eu

secret_file=/run/secrets/turn_secret
[ -s "$secret_file" ] || { echo "turn_secret is missing or empty" >&2; exit 1; }
[ -n "${TURN_REALM:-}" ] || { echo "TURN_REALM is required" >&2; exit 1; }

umask 077
conf=/tmp/turnserver.conf
# The template's realm line is a placeholder; drop it and set the real one.
grep -v '^realm=' /etc/coturn/turnserver.conf > "$conf"
{
  printf 'static-auth-secret=%s\n' "$(cat "$secret_file")"
  printf 'realm=%s\n' "$TURN_REALM"
  if [ -n "${TURN_EXTERNAL_IP:-}" ]; then printf 'external-ip=%s\n' "$TURN_EXTERNAL_IP"; fi
} >> "$conf"

exec turnserver -c "$conf"
