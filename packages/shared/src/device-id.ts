import { z } from 'zod';

/**
 * Device IDs are 9 digits: an 8-digit payload followed by a Luhn check digit.
 * The check digit catches the most common typing mistakes (single wrong digit,
 * adjacent transposition) before a connection attempt ever leaves the client.
 *
 * Canonical form: "123456789". Display form: "123 456 789".
 */
export const DEVICE_ID_LENGTH = 9;
export const DEVICE_ID_PAYLOAD_LENGTH = DEVICE_ID_LENGTH - 1;

const SEPARATORS = /[\s-]/g;
const CANONICAL_PATTERN = /^\d{9}$/;
const PAYLOAD_PATTERN = /^\d{8}$/;

/** Strips the separators users commonly type or paste (spaces, dashes). */
export function normalizeDeviceId(input: string): string {
  return input.trim().replace(SEPARATORS, '');
}

/** Computes the Luhn check digit for a string of decimal digits. */
export function computeLuhnCheckDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    // Walk from the rightmost digit; double every digit at an even offset.
    let digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10;
}

/** True when the input is 9 digits (after normalisation) with a valid check digit. */
export function isValidDeviceId(input: string): boolean {
  const id = normalizeDeviceId(input);
  if (!CANONICAL_PATTERN.test(id)) return false;
  const payload = id.slice(0, DEVICE_ID_PAYLOAD_LENGTH);
  const check = id.charCodeAt(DEVICE_ID_PAYLOAD_LENGTH) - 48;
  return computeLuhnCheckDigit(payload) === check;
}

/** Builds a canonical device ID from an 8-digit payload. */
export function createDeviceId(payload: string): string {
  if (!PAYLOAD_PATTERN.test(payload)) {
    throw new Error(`Device ID payload must be exactly ${DEVICE_ID_PAYLOAD_LENGTH} digits`);
  }
  return `${payload}${computeLuhnCheckDigit(payload)}`;
}

/** Formats a device ID in groups of three for display. Leaves partial input readable. */
export function formatDeviceId(input: string): string {
  const digits = normalizeDeviceId(input).replace(/\D/g, '').slice(0, DEVICE_ID_LENGTH);
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ');
}

export const DEVICE_ID_MESSAGES = {
  required: 'Enter a device ID',
  format: `Device ID must be ${DEVICE_ID_LENGTH} digits`,
  checksum: 'This device ID is not valid. Check it for typos.',
} as const;

/**
 * Accepts user-typed IDs ("123 456 789", "123-456-789") and outputs the canonical
 * 9-digit form. Use this for every ID that crosses a trust boundary.
 */
export const deviceIdSchema = z
  .string({ error: DEVICE_ID_MESSAGES.required })
  .transform(normalizeDeviceId)
  .pipe(
    z
      .string()
      .min(1, DEVICE_ID_MESSAGES.required)
      .regex(CANONICAL_PATTERN, DEVICE_ID_MESSAGES.format)
      .refine(isValidDeviceId, DEVICE_ID_MESSAGES.checksum),
  );

export type DeviceId = z.output<typeof deviceIdSchema>;
