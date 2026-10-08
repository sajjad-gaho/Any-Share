/**
 * Host-side authorization of peer requests. Pure functions, so the rules that
 * stand between a remote peer and SendInput are easy to test.
 *
 * `permissions` here always come from the signaling server (approval acks,
 * permission updates, verify responses) — never from the peer or the renderer.
 */
import type { SessionPermission } from '@remote-desktop/shared';
import type { InputMessage, SpecialCombo } from '@remote-desktop/webrtc';
import type { HelperCommand } from '../native/protocol';

/** The part of the virtual desktop being shared, in physical pixels. */
export interface CaptureArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type InputDecision =
  { allowed: true; commands: HelperCommand[] } | { allowed: false; reason: string };

/** Same allowlist as native/windows-helper/src/keymap.rs (the helper re-checks). */
export const ALLOWED_KEY_CODES: ReadonlySet<string> = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
  ...'0123456789'.split('').map((d) => `Digit${d}`),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...'0123456789'.split('').map((d) => `Numpad${d}`),
  'Escape',
  'Minus',
  'Equal',
  'Backspace',
  'Tab',
  'BracketLeft',
  'BracketRight',
  'Enter',
  'ControlLeft',
  'ControlRight',
  'Semicolon',
  'Quote',
  'Backquote',
  'ShiftLeft',
  'ShiftRight',
  'Backslash',
  'Comma',
  'Period',
  'Slash',
  'AltLeft',
  'AltRight',
  'Space',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'NumpadMultiply',
  'NumpadSubtract',
  'NumpadAdd',
  'NumpadDecimal',
  'NumpadEnter',
  'NumpadDivide',
  'IntlBackslash',
  'PrintScreen',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'MetaLeft',
  'MetaRight',
  'ContextMenu',
]);

const COMBOS: Readonly<Record<SpecialCombo, readonly string[]>> = {
  win: ['MetaLeft'],
  alt_tab: ['AltLeft', 'Tab'],
  ctrl_shift_esc: ['ControlLeft', 'ShiftLeft', 'Escape'],
  ctrl_esc: ['ControlLeft', 'Escape'],
  print_screen: ['PrintScreen'],
};

const deny = (reason: string): InputDecision => ({ allowed: false, reason });

function can(permissions: readonly SessionPermission[], ...needed: SessionPermission[]): boolean {
  return needed.every((p) => permissions.includes(p));
}

function key(code: string, action: 'down' | 'up'): HelperCommand {
  return { cmd: 'KEYBOARD_EVENT', args: { code, action } };
}

/**
 * Decides whether a validated input message may be injected, and turns it into
 * helper commands. Pointer positions are confined to the shared area, so a
 * peer can never click on a monitor the host is not showing it.
 */
export function authorizeInput(
  message: InputMessage,
  permissions: readonly SessionPermission[],
  area: CaptureArea | null,
): InputDecision {
  // Releasing held input is always safe and always allowed.
  if (message.t === 'release') return { allowed: true, commands: [{ cmd: 'RELEASE_ALL_INPUT' }] };

  const isPointer =
    message.t === 'mm' ||
    message.t === 'md' ||
    message.t === 'mu' ||
    message.t === 'mc' ||
    message.t === 'ms';
  if (isPointer) {
    if (!can(permissions, 'remote_control', 'mouse')) return deny('mouse_not_permitted');
    switch (message.t) {
      case 'mm': {
        if (!area || area.width <= 0 || area.height <= 0) return deny('no_capture_area');
        const x = area.x + Math.round(message.x * (area.width - 1));
        const y = area.y + Math.round(message.y * (area.height - 1));
        return { allowed: true, commands: [{ cmd: 'MOUSE_MOVE', args: { x, y } }] };
      }
      case 'md':
        return {
          allowed: true,
          commands: [{ cmd: 'MOUSE_BUTTON', args: { button: message.b, action: 'down' } }],
        };
      case 'mu':
        return {
          allowed: true,
          commands: [{ cmd: 'MOUSE_BUTTON', args: { button: message.b, action: 'up' } }],
        };
      case 'mc':
        return {
          allowed: true,
          commands: [{ cmd: 'MOUSE_CLICK', args: { button: message.b, count: message.n } }],
        };
      case 'ms':
        return {
          allowed: true,
          commands: [{ cmd: 'MOUSE_SCROLL', args: { deltaX: message.dx, deltaY: message.dy } }],
        };
    }
  }

  if (!can(permissions, 'remote_control', 'keyboard')) return deny('keyboard_not_permitted');
  switch (message.t) {
    case 'kd':
    case 'ku':
      if (!ALLOWED_KEY_CODES.has(message.c)) return deny('key_not_allowed');
      return { allowed: true, commands: [key(message.c, message.t === 'kd' ? 'down' : 'up')] };
    case 'combo': {
      const keys = COMBOS[message.combo];
      return {
        allowed: true,
        commands: [
          ...keys.map((k) => key(k, 'down')),
          ...[...keys].reverse().map((k) => key(k, 'up')),
        ],
      };
    }
    default:
      return deny('unknown_input');
  }
}

/** Clipboard reads and writes both need the clipboard permission. */
export function canUseClipboard(permissions: readonly SessionPermission[]): boolean {
  return permissions.includes('clipboard');
}

export function canTransferFiles(permissions: readonly SessionPermission[]): boolean {
  return permissions.includes('file_transfer');
}

/** Bounding box of several monitors (the "all monitors" view). */
export function boundingArea(areas: readonly CaptureArea[]): CaptureArea | null {
  if (areas.length === 0) return null;
  const left = Math.min(...areas.map((a) => a.x));
  const top = Math.min(...areas.map((a) => a.y));
  const right = Math.max(...areas.map((a) => a.x + a.width));
  const bottom = Math.max(...areas.map((a) => a.y + a.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
