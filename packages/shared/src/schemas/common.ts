import { z } from 'zod';

export const uuidSchema = z.uuid();

/** ISO-8601 timestamp. Offsets are accepted; storage should always be UTC. */
export const timestampSchema = z.iso.datetime({ offset: true });

/** Rejects ASCII control characters, which have no place in human-readable labels. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function boundedText(min: number, max: number, label: string) {
  return z
    .string()
    .trim()
    .min(min, min === 1 ? `${label} is required` : `${label} must be at least ${min} characters`)
    .max(max, `${label} must be at most ${max} characters`)
    .refine((value) => !CONTROL_CHARS.test(value), `${label} contains invalid characters`);
}
