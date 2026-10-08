import { createHmac } from 'node:crypto';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceConfigOptions {
  stunUrls: readonly string[];
  turnUrls: readonly string[];
  turnSecret: string | undefined;
  ttlSeconds: number;
}

/**
 * Builds the ICE server list for one authorized session participant.
 *
 * TURN uses coturn's shared-secret mechanism (`use-auth-secret`, the "TURN
 * REST API"): the username is `<expiry unix seconds>:<user id>` and the
 * password is base64(HMAC-SHA1(secret, username)). coturn recomputes the HMAC
 * and refuses expired usernames, so credentials are short-lived, per user,
 * and the shared secret never leaves the server. Clients only receive these
 * after the server has authorized a session — knowing a device ID is not enough.
 */
export function buildIceServers(
  options: IceConfigOptions,
  userId: string,
  nowMs: number = Date.now(),
): { iceServers: IceServer[]; expiresAt: string } {
  const expiry = Math.floor(nowMs / 1000) + options.ttlSeconds;
  const iceServers: IceServer[] = [];
  if (options.stunUrls.length > 0) iceServers.push({ urls: [...options.stunUrls] });
  if (options.turnUrls.length > 0 && options.turnSecret) {
    const username = `${expiry}:${userId}`;
    const credential = createHmac('sha1', options.turnSecret).update(username).digest('base64');
    iceServers.push({ urls: [...options.turnUrls], username, credential });
  }
  return { iceServers, expiresAt: new Date(expiry * 1000).toISOString() };
}
