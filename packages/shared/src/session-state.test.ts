import { describe, expect, it } from 'vitest';
import {
  InvalidSessionTransitionError,
  SESSION_STATES,
  SESSION_TRANSITIONS,
  TERMINAL_SESSION_STATES,
  assertTransition,
  canTransition,
} from './session-state';

describe('session state machine', () => {
  it('walks the happy path', () => {
    const path = [
      'IDLE',
      'REQUESTING',
      'APPROVAL_PENDING',
      'AUTHORIZING',
      'SIGNALING',
      'CONNECTING',
      'CONNECTED',
      'RECONNECTING',
      'CONNECTED',
      'ENDING',
      'ENDED',
    ] as const;
    for (let i = 1; i < path.length; i++) {
      const from = path[i - 1] ?? 'IDLE';
      const to = path[i] ?? 'IDLE';
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it('rejects skipping approval and authorization', () => {
    expect(canTransition('REQUESTING', 'CONNECTED')).toBe(false);
    expect(canTransition('APPROVAL_PENDING', 'SIGNALING')).toBe(false);
    expect(canTransition('IDLE', 'CONNECTED')).toBe(false);
    expect(() => assertTransition('APPROVAL_PENDING', 'CONNECTED')).toThrow(
      InvalidSessionTransitionError,
    );
  });

  it('treats terminal states as final', () => {
    for (const state of TERMINAL_SESSION_STATES) {
      expect(SESSION_TRANSITIONS[state]).toEqual([]);
      for (const to of SESSION_STATES) expect(canTransition(state, to)).toBe(false);
    }
  });

  it('never transitions to itself or back to IDLE', () => {
    for (const from of SESSION_STATES) {
      expect(canTransition(from, from)).toBe(false);
      expect(canTransition(from, 'IDLE')).toBe(false);
    }
  });

  it('lets every live state fail', () => {
    for (const state of SESSION_STATES) {
      if (state === 'IDLE' || TERMINAL_SESSION_STATES.includes(state)) continue;
      expect(canTransition(state, 'FAILED'), state).toBe(true);
    }
  });
});
