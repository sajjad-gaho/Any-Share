import { describe, expect, it } from 'vitest';
import {
  DEVICE_ID_MESSAGES,
  computeLuhnCheckDigit,
  createDeviceId,
  deviceIdSchema,
  formatDeviceId,
  isValidDeviceId,
  normalizeDeviceId,
} from './device-id';

const VALID_ID = '123456782'; // payload 12345678 + Luhn check digit 2

describe('computeLuhnCheckDigit', () => {
  it('matches known Luhn values', () => {
    expect(computeLuhnCheckDigit('12345678')).toBe(2);
    expect(computeLuhnCheckDigit('7992739871')).toBe(3); // canonical Luhn example
    expect(computeLuhnCheckDigit('00000000')).toBe(0);
  });
});

describe('createDeviceId', () => {
  it('appends the check digit', () => {
    expect(createDeviceId('12345678')).toBe(VALID_ID);
  });

  it('rejects malformed payloads', () => {
    expect(() => createDeviceId('1234567')).toThrow();
    expect(() => createDeviceId('1234567a')).toThrow();
  });
});

describe('normalizeDeviceId / formatDeviceId', () => {
  it('strips spaces and dashes', () => {
    expect(normalizeDeviceId(' 123 456-782 ')).toBe(VALID_ID);
  });

  it('formats complete and partial IDs in groups of three', () => {
    expect(formatDeviceId(VALID_ID)).toBe('123 456 782');
    expect(formatDeviceId('1234')).toBe('123 4');
    expect(formatDeviceId('123')).toBe('123');
    expect(formatDeviceId('12a3-45')).toBe('123 45');
    expect(formatDeviceId('1234567890000')).toBe('123 456 789');
  });
});

describe('isValidDeviceId', () => {
  it('accepts valid IDs in any common notation', () => {
    expect(isValidDeviceId(VALID_ID)).toBe(true);
    expect(isValidDeviceId('123 456 782')).toBe(true);
    expect(isValidDeviceId('123-456-782')).toBe(true);
  });

  it('detects a single mistyped digit', () => {
    expect(isValidDeviceId('123456783')).toBe(false);
    expect(isValidDeviceId('923456782')).toBe(false);
  });

  it('detects adjacent transpositions', () => {
    expect(isValidDeviceId('213456782')).toBe(false);
  });

  it('rejects wrong lengths and non-digits', () => {
    expect(isValidDeviceId('')).toBe(false);
    expect(isValidDeviceId('12345678')).toBe(false);
    expect(isValidDeviceId('1234567820')).toBe(false);
    expect(isValidDeviceId('12345678a')).toBe(false);
  });
});

describe('deviceIdSchema', () => {
  it('outputs the canonical form', () => {
    expect(deviceIdSchema.parse('123 456 782')).toBe(VALID_ID);
  });

  it.each([
    ['', DEVICE_ID_MESSAGES.required],
    ['1234', DEVICE_ID_MESSAGES.format],
    ['abcdefghi', DEVICE_ID_MESSAGES.format],
    ['123456783', DEVICE_ID_MESSAGES.checksum],
  ])('rejects %j with a helpful message', (input, message) => {
    const result = deviceIdSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(message);
  });

  it('rejects non-string input', () => {
    expect(deviceIdSchema.safeParse(123456782).success).toBe(false);
    expect(deviceIdSchema.safeParse(undefined).success).toBe(false);
  });
});
