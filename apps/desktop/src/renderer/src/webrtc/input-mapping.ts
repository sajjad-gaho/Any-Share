/**
 * Controller-side translation of DOM events into DataChannel input messages.
 * Pure functions: the host re-validates and re-authorizes everything anyway.
 */
import type { InputMessage, MouseButtonName } from '@remote-desktop/webrtc';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Maps a pointer position over a <video> showing the remote screen with
 * `object-fit: contain` to normalised remote coordinates (0..1). Points in the
 * letterbox bars map to null.
 */
export function normalizePointer(
  clientX: number,
  clientY: number,
  element: Rect,
  videoWidth: number,
  videoHeight: number,
): { x: number; y: number } | null {
  if (videoWidth <= 0 || videoHeight <= 0 || element.width <= 0 || element.height <= 0) return null;
  const scale = Math.min(element.width / videoWidth, element.height / videoHeight);
  const shownWidth = videoWidth * scale;
  const shownHeight = videoHeight * scale;
  const offsetX = (element.width - shownWidth) / 2;
  const offsetY = (element.height - shownHeight) / 2;
  const x = (clientX - element.left - offsetX) / shownWidth;
  const y = (clientY - element.top - offsetY) / shownHeight;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
}

/** DOM MouseEvent.button -> remote button. Back/forward buttons are not forwarded. */
export function mouseButton(button: number): MouseButtonName | null {
  return button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : null;
}

const WHEEL_DELTA = 120;

/**
 * DOM wheel deltas -> Windows wheel units (120 per notch; positive = up/right
 * for the vertical/horizontal wheel respectively).
 */
export function wheelToRemote(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
): { dx: number; dy: number } {
  const factor = deltaMode === 1 ? WHEEL_DELTA / 3 : deltaMode === 2 ? WHEEL_DELTA * 3 : 1.2;
  const clamp = (v: number) => Math.max(-2400, Math.min(2400, Math.round(v)));
  return { dx: clamp(deltaX * factor), dy: clamp(-deltaY * factor) };
}

/** Physical keys we forward (mirrors the host and helper allowlists). */
const KEY_CODE =
  /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Numpad([0-9]|Multiply|Subtract|Add|Decimal|Enter|Divide)|Arrow(Up|Down|Left|Right)|(Shift|Control|Alt|Meta)(Left|Right)|Escape|Minus|Equal|Backspace|Tab|Bracket(Left|Right)|Enter|Semicolon|Quote|Backquote|Backslash|Comma|Period|Slash|Space|CapsLock|NumLock|ScrollLock|IntlBackslash|PrintScreen|Home|End|PageUp|PageDown|Insert|Delete|ContextMenu)$/;

export function keyMessage(code: string, down: boolean): InputMessage | null {
  if (!KEY_CODE.test(code)) return null;
  return down ? { t: 'kd', c: code } : { t: 'ku', c: code };
}
