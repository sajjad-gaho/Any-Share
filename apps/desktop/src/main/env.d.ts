/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  /** Public API base URL, injected at build time. Not a secret. */
  readonly MAIN_VITE_API_URL?: string;
  /** Public signaling WebSocket URL, injected at build time. Not a secret. */
  readonly MAIN_VITE_SIGNALING_URL?: string;
  /** 'true' only for a LAN test build: allows http/ws to private LAN addresses. */
  readonly MAIN_VITE_ALLOW_LAN_HTTP?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
