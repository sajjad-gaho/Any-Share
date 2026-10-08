import type { DesktopApi } from '../../shared/ipc';

declare global {
  interface Window {
    /** Exposed by the preload script. Undefined outside Electron (e.g. unit tests). */
    readonly desktop?: DesktopApi;
  }
}

export {};
