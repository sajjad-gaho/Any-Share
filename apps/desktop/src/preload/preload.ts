/**
 * Preload script (sandboxed).
 *
 * Exposes a small, typed, method-per-capability API as `window.desktop`.
 * Rules:
 *  - never expose ipcRenderer itself, or a generic invoke(channel, ...args);
 *  - never expose Node primitives (fs, child_process, shell, process);
 *  - only pass plain, structured-cloneable data across the bridge;
 *  - never pass tokens or keys to the renderer.
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  IPC_EVENTS,
  NATIVE_FRAMES_MESSAGE,
  type DesktopApi,
  type SessionEvent,
} from '../shared/ipc';

const invoke = ipcRenderer.invoke.bind(ipcRenderer);

// The preload is type-checked without DOM types; this is the one DOM call it makes.
declare const window: {
  postMessage(
    message: unknown,
    targetOrigin: string,
    transfer?: Electron.IpcRendererEvent['ports'],
  ): void;
};

const api: DesktopApi = {
  app: {
    getInfo: () => invoke(IPC_CHANNELS.appGetInfo),
  },
  theme: {
    setSource: (source) => invoke(IPC_CHANNELS.themeSetSource, source),
  },
  auth: {
    getState: () => invoke(IPC_CHANNELS.authGetState),
    login: (input) => invoke(IPC_CHANNELS.authLogin, input),
    register: (input) => invoke(IPC_CHANNELS.authRegister, input),
    logout: () => invoke(IPC_CHANNELS.authLogout),
    requestPasswordReset: (email) => invoke(IPC_CHANNELS.authRequestPasswordReset, email),
    confirmPasswordReset: (input) => invoke(IPC_CHANNELS.authConfirmPasswordReset, input),
  },
  devices: {
    list: () => invoke(IPC_CHANNELS.devicesList),
  },
  sessions: {
    list: () => invoke(IPC_CHANNELS.sessionsList),
  },
  thisDevice: {
    get: () => invoke(IPC_CHANNELS.thisDeviceGet),
    register: (name) => invoke(IPC_CHANNELS.thisDeviceRegister, name),
    getSettings: () => invoke(IPC_CHANNELS.thisDeviceSettingsGet),
    updateSettings: (update) => invoke(IPC_CHANNELS.thisDeviceSettingsUpdate, update),
  },
  teams: {
    list: () => invoke(IPC_CHANNELS.teamsList),
    create: (input) => invoke(IPC_CHANNELS.teamsCreate, input),
    members: (teamId) => invoke(IPC_CHANNELS.teamsMembers, teamId),
    addMember: (teamId, input) => invoke(IPC_CHANNELS.teamsAddMember, teamId, input),
    updateMember: (teamId, userId, role) =>
      invoke(IPC_CHANNELS.teamsUpdateMember, teamId, userId, role),
    removeMember: (teamId, userId) => invoke(IPC_CHANNELS.teamsRemoveMember, teamId, userId),
  },
  audit: {
    list: (options) => invoke(IPC_CHANNELS.auditList, options),
  },
  session: {
    start: (input) => invoke(IPC_CHANNELS.sessionStart, input),
    ready: (sessionId) => invoke(IPC_CHANNELS.sessionReady, sessionId),
    signal: (sessionId, signal) => invoke(IPC_CHANNELS.sessionSignal, sessionId, signal),
    report: (sessionId, state) => invoke(IPC_CHANNELS.sessionReport, sessionId, state),
    end: (sessionId, reason) => invoke(IPC_CHANNELS.sessionEnd, sessionId, reason),
    setPermissions: (sessionId, permissions) =>
      invoke(IPC_CHANNELS.sessionSetPermissions, sessionId, permissions),
    signalingStatus: () => invoke(IPC_CHANNELS.signalingStatus),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: SessionEvent) =>
        listener(payload);
      ipcRenderer.on(IPC_EVENTS.session, handler);
      return () => ipcRenderer.removeListener(IPC_EVENTS.session, handler);
    },
  },
  host: {
    input: (sessionId, message) => invoke(IPC_CHANNELS.hostInput, sessionId, message),
    readClipboard: (sessionId) => invoke(IPC_CHANNELS.hostReadClipboard, sessionId),
    writeClipboard: (sessionId, text) => invoke(IPC_CHANNELS.hostWriteClipboard, sessionId, text),
    monitors: (sessionId) => invoke(IPC_CHANNELS.hostMonitors, sessionId),
    selectMonitor: (sessionId, selection) =>
      invoke(IPC_CHANNELS.hostSelectMonitor, sessionId, selection),
    setFollow: (sessionId, enabled) => invoke(IPC_CHANNELS.hostSetFollow, sessionId, enabled),
    startNativeCapture: (sessionId, options) =>
      invoke(IPC_CHANNELS.hostStartNativeCapture, sessionId, options),
    stopNativeCapture: (sessionId) => invoke(IPC_CHANNELS.hostStopNativeCapture, sessionId),
  },
  controller: {
    readClipboard: (sessionId) => invoke(IPC_CHANNELS.controllerReadClipboard, sessionId),
    writeClipboard: (sessionId, text) =>
      invoke(IPC_CHANNELS.controllerWriteClipboard, sessionId, text),
  },
  files: {
    begin: (sessionId, offer) => invoke(IPC_CHANNELS.filesBegin, sessionId, offer),
    chunk: (sessionId, id, data) => invoke(IPC_CHANNELS.filesChunk, sessionId, id, data),
    finish: (sessionId, id, sha256) => invoke(IPC_CHANNELS.filesFinish, sessionId, id, sha256),
    cancel: (sessionId, id) => invoke(IPC_CHANNELS.filesCancel, sessionId, id),
    openFolder: () => invoke(IPC_CHANNELS.filesOpenFolder),
  },
};

// Native fallback capture: main hands over a MessagePort; pass it to the page.
ipcRenderer.on(IPC_EVENTS.nativeFramesPort, (event) => {
  window.postMessage({ type: NATIVE_FRAMES_MESSAGE }, '*', event.ports);
});

contextBridge.exposeInMainWorld('desktop', Object.freeze(api));
