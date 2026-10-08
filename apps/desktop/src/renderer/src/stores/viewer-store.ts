import type { DeviceId } from '@remote-desktop/shared';
import type { ConnectionStatus } from '@remote-desktop/webrtc';
import { create } from 'zustand';

/**
 * State of the remote viewer window.
 *
 * Phase 1: there is no transport, so `status` never leaves "not-connected" and
 * `connectedAt` stays null. The shape is what the Phase 2 WebRTC session
 * controller will drive.
 */
interface ViewerState {
  deviceId: DeviceId | null;
  status: ConnectionStatus;
  connectedAt: string | null;
  open: (deviceId: DeviceId) => void;
  close: () => void;
}

const initialState = { deviceId: null, status: 'not-connected', connectedAt: null } as const;

export const useViewerStore = create<ViewerState>()((set) => ({
  ...initialState,
  open: (deviceId) =>
    // TODO(phase-2): start a WebRTC session here and update status from its events.
    set({ deviceId, status: 'not-connected', connectedAt: null }),
  close: () => set(initialState),
}));
