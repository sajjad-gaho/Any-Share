import { z } from 'zod';

/**
 * Server-side lifecycle of a remote session (`sessions.state`).
 *
 * The same transition table is enforced by the `enforce_session_transition`
 * trigger in `supabase/migrations`; `session-state.test.ts` keeps the two in sync.
 */
export const SESSION_STATES = [
  'IDLE',
  'REQUESTING',
  'APPROVAL_PENDING',
  'AUTHORIZING',
  'SIGNALING',
  'CONNECTING',
  'CONNECTED',
  'RECONNECTING',
  'ENDING',
  'ENDED',
  'FAILED',
  'EXPIRED',
] as const;
export const sessionStateSchema = z.enum(SESSION_STATES);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const SESSION_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  IDLE: ['REQUESTING'],
  REQUESTING: ['APPROVAL_PENDING', 'AUTHORIZING', 'ENDED', 'FAILED', 'EXPIRED'],
  APPROVAL_PENDING: ['AUTHORIZING', 'ENDED', 'FAILED', 'EXPIRED'],
  AUTHORIZING: ['SIGNALING', 'ENDING', 'FAILED'],
  SIGNALING: ['CONNECTING', 'ENDING', 'FAILED', 'EXPIRED'],
  CONNECTING: ['CONNECTED', 'RECONNECTING', 'ENDING', 'FAILED'],
  CONNECTED: ['RECONNECTING', 'ENDING', 'FAILED'],
  RECONNECTING: ['CONNECTING', 'CONNECTED', 'ENDING', 'FAILED', 'EXPIRED'],
  ENDING: ['ENDED', 'FAILED'],
  ENDED: [],
  FAILED: [],
  EXPIRED: [],
};

export const TERMINAL_SESSION_STATES: readonly SessionState[] = ['ENDED', 'FAILED', 'EXPIRED'];

/** States in which WebRTC negotiation messages may be relayed. */
export const SIGNALING_SESSION_STATES: readonly SessionState[] = [
  'SIGNALING',
  'CONNECTING',
  'CONNECTED',
  'RECONNECTING',
];

export function canTransition(from: SessionState, to: SessionState): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

export function isTerminalSessionState(state: SessionState): boolean {
  return TERMINAL_SESSION_STATES.includes(state);
}

export class InvalidSessionTransitionError extends Error {
  constructor(
    readonly from: SessionState,
    readonly to: SessionState,
  ) {
    super(`Invalid session transition ${from} -> ${to}`);
    this.name = 'InvalidSessionTransitionError';
  }
}

export function assertTransition(from: SessionState, to: SessionState): void {
  if (!canTransition(from, to)) throw new InvalidSessionTransitionError(from, to);
}
