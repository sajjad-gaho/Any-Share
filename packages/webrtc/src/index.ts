/**
 * WebRTC contracts.
 *
 * Signaling protocol (apps/signaling), DataChannel protocol between peers and
 * the adaptive-quality policy. Pure TypeScript: the peer connections live in
 * the desktop renderer, input injection in the native helper.
 */
export * from './datachannel';
export * from './quality';
export * from './signaling';

/** Connection lifecycle as surfaced to the UI. */
export type ConnectionStatus =
  'not-connected' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

/** ICE server entry as distributed by the backend (STUN/TURN credentials are short-lived). */
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Data channels planned for a session. Media (screen, audio) uses tracks, not channels. */
export type DataChannelLabel = 'input' | 'clipboard' | 'file-transfer' | 'control';
