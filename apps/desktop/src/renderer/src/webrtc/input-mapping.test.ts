import { describe, expect, it } from 'vitest';
import { keyMessage, mouseButton, normalizePointer, wheelToRemote } from './input-mapping';

describe('normalizePointer', () => {
  // 1000x500 element showing a 1920x1080 stream: scaled to 888.9x500, centred.
  const element = { left: 100, top: 50, width: 1000, height: 500 };

  it('maps the visible picture to 0..1', () => {
    const shownWidth = (1920 * 500) / 1080;
    const offset = (1000 - shownWidth) / 2;
    expect(normalizePointer(100 + offset, 50, element, 1920, 1080)).toEqual({ x: 0, y: 0 });
    expect(normalizePointer(100 + offset + shownWidth, 550, element, 1920, 1080)).toEqual({
      x: 1,
      y: 1,
    });
    expect(normalizePointer(600, 300, element, 1920, 1080)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('ignores the letterbox bars and empty video', () => {
    expect(normalizePointer(105, 300, element, 1920, 1080)).toBeNull();
    expect(normalizePointer(600, 300, element, 0, 0)).toBeNull();
  });
});

describe('input helpers', () => {
  it('maps buttons and refuses back/forward', () => {
    expect([0, 1, 2, 3].map(mouseButton)).toEqual(['left', 'middle', 'right', null]);
  });

  it('converts wheel deltas to Windows units', () => {
    expect(wheelToRemote(0, 100, 0)).toEqual({ dx: 0, dy: -120 });
    expect(wheelToRemote(0, -3, 1)).toEqual({ dx: 0, dy: 120 });
    expect(wheelToRemote(0, 1e6, 0).dy).toBe(-2400);
  });

  it('forwards only allowlisted physical keys', () => {
    expect(keyMessage('KeyA', true)).toEqual({ t: 'kd', c: 'KeyA' });
    expect(keyMessage('ShiftLeft', false)).toEqual({ t: 'ku', c: 'ShiftLeft' });
    expect(keyMessage('MediaPlayPause', true)).toBeNull();
    expect(keyMessage('', true)).toBeNull();
  });
});
