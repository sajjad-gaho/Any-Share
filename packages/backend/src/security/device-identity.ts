import { createHash, createPublicKey, randomInt, verify, type KeyObject } from 'node:crypto';
import { DEVICE_ID_PAYLOAD_LENGTH, createDeviceId } from '@remote-desktop/shared';
import { badRequest } from '../errors';

/**
 * Device identity
 * ---------------
 * * The 9-digit device code is a public, human-friendly address. It is random
 *   (not sequential) but carries no authority: knowing it never grants access.
 * * Authority comes from an Ed25519 key pair generated on the device. The
 *   private key never leaves the device (the desktop app keeps it encrypted
 *   with the OS keystore via Electron safeStorage); the server stores only the
 *   public key and its SHA-256 fingerprint.
 * * A device proves its identity to the signaling service by signing a
 *   server-issued, single-use nonce (`deviceAuthMessage` in @remote-desktop/webrtc).
 */

const PAYLOAD_MAX = 10 ** DEVICE_ID_PAYLOAD_LENGTH;

export function generateDeviceCode(): string {
  const payload = String(randomInt(0, PAYLOAD_MAX)).padStart(DEVICE_ID_PAYLOAD_LENGTH, '0');
  return createDeviceId(payload);
}

/** Parses a base64 SPKI DER Ed25519 public key; rejects anything else. */
export function parseDevicePublicKey(base64: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw badRequest('Device public key is not a valid SPKI key');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw badRequest('Device public key must be Ed25519');
  }
  return key;
}

export function publicKeyFingerprint(base64: string): string {
  return createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
}

export function verifyDeviceSignature(
  publicKeyBase64: string,
  message: string,
  signatureBase64: string,
): boolean {
  try {
    const key = parseDevicePublicKey(publicKeyBase64);
    const signature = Buffer.from(signatureBase64, 'base64');
    if (signature.length !== 64) return false;
    return verify(null, Buffer.from(message, 'utf8'), key, signature);
  } catch {
    return false;
  }
}
