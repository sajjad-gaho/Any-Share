/**
 * Public client configuration. The desktop app knows only where the API is;
 * it holds no Supabase keys at all (and must never hold the service-role key).
 *
 * Set at build time via `MAIN_VITE_API_URL` (see apps/desktop/.env.example).
 */
export const DEV_API_URL = 'http://127.0.0.1:8080';

/**
 * Whether `hostname` is a private (RFC 1918) IPv4 address: 10/8, 172.16/12
 * or 192.168/16. Names are never accepted, so a DNS answer cannot turn a
 * public host into an "allowed" plain-HTTP target.
 */
export function isPrivateLanHost(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Plain `http:`/`ws:` is accepted only for local development on loopback, or
 * on a private LAN address when the build opted in with
 * `MAIN_VITE_ALLOW_LAN_HTTP=true` (a LAN test build; never for distribution).
 */
function plainAllowed(url: URL, isPackaged: boolean, allowLanHttp: boolean): boolean {
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (loopback && !isPackaged) return true;
  return allowLanHttp && isPrivateLanHost(url.hostname);
}

/**
 * Returns the API base URL, or null when the backend is not configured.
 * Packaged builds require HTTPS; plain HTTP is accepted only for local development
 * (and private LAN addresses in an opted-in LAN test build).
 */
export function resolveApiBaseUrl(
  configured: string | undefined,
  isPackaged: boolean,
  allowLanHttp = false,
): string | null {
  const value = configured?.trim() || (isPackaged ? '' : DEV_API_URL);
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url.origin + url.pathname.replace(/\/+$/, '');
  if (url.protocol === 'http:' && plainAllowed(url, isPackaged, allowLanHttp)) return url.origin;
  return null;
}

export const DEV_SIGNALING_URL = 'ws://127.0.0.1:8081/ws';

/**
 * Signaling WebSocket URL (`MAIN_VITE_SIGNALING_URL`). Packaged builds require
 * wss:; plain ws: is accepted only for local development on loopback (and
 * private LAN addresses in an opted-in LAN test build).
 */
export function resolveSignalingUrl(
  configured: string | undefined,
  isPackaged: boolean,
  allowLanHttp = false,
): string | null {
  const value = configured?.trim() || (isPackaged ? '' : DEV_SIGNALING_URL);
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === 'wss:') return url.toString();
  if (url.protocol === 'ws:' && plainAllowed(url, isPackaged, allowLanHttp)) return url.toString();
  return null;
}
