import { hash, verify } from '@node-rs/argon2';

/** `Algorithm.Argon2id` (a const enum, which `verbatimModuleSyntax` cannot import). */
const ARGON2ID_ALGORITHM = 2;

/**
 * Argon2id parameters for application-managed secrets (device access passwords).
 * OWASP's baseline recommendation: m=19 MiB, t=2, p=1. User account passwords
 * are not handled here — Supabase Auth stores those.
 */
const ARGON2ID = {
  algorithm: ARGON2ID_ALGORITHM,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashSecret(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2ID);
}

/** Constant-time comparison is done inside argon2. Malformed hashes verify as false. */
export async function verifySecret(phcHash: string, plaintext: string): Promise<boolean> {
  if (!phcHash.startsWith('$argon2id$')) return false;
  try {
    return await verify(phcHash, plaintext);
  } catch {
    return false;
  }
}
