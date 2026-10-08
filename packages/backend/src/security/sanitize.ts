import type { AuditMetadata } from '@remote-desktop/shared';

/**
 * Keys that must never reach the audit log, whatever a caller passes in:
 * credentials, tokens, keys and user content (clipboard, file data, SDP).
 */
const FORBIDDEN_KEY =
  /pass(word)?|token|secret|private|key|signature|credential|cookie|authorization|clipboard|content|sdp|candidate|^otp$|^code$/i;

const MAX_KEYS = 30;
const MAX_STRING = 500;

/**
 * Reduces arbitrary metadata to a flat record of primitives with sensitive
 * keys removed. Nested objects and arrays are dropped rather than serialised.
 */
export function sanitizeAuditMetadata(input: Record<string, unknown> | undefined): AuditMetadata {
  const output: AuditMetadata = {};
  if (!input) return output;
  let kept = 0;
  for (const [key, value] of Object.entries(input)) {
    if (kept >= MAX_KEYS) break;
    if (key.length > 64 || FORBIDDEN_KEY.test(key)) continue;
    if (typeof value === 'string') output[key] = value.slice(0, MAX_STRING);
    else if (typeof value === 'number' && Number.isFinite(value)) output[key] = value;
    else if (typeof value === 'boolean' || value === null) output[key] = value;
    else continue;
    kept += 1;
  }
  return output;
}
