import { describe, expect, it } from 'vitest';
import { formatDuration, formatRelativeTime } from './format';

describe('formatDuration', () => {
  it('formats short and long durations', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(65_000)).toBe('01:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(-5)).toBe('00:00');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');

  it('describes past times', () => {
    expect(formatRelativeTime('2026-09-10T11:59:30.000Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-09-10T11:55:00.000Z', now)).toBe('5 minutes ago');
    expect(formatRelativeTime('2026-09-09T12:00:00.000Z', now)).toBe('yesterday');
  });
});
