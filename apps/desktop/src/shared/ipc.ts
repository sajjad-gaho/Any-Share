/**
 * The complete contract between the renderer and the main process.
 *
 * This file is imported by main, preload and renderer. It must stay free of
 * runtime dependencies on Node or Electron. Adding a capability means:
 *   1. add a channel + method here,
 *   2. validate its arguments in main/ipc.ts,
 *   3. expose it in preload/preload.ts.
 * Never expose generic primitives (send-any-channel, fs, shell, process).
 *
 * Security: access/refresh tokens and the device private key live only in the
 * main process. The renderer receives user and device *information*, never
 * credentials.
 */
import type {
  AuditLog,
  DeviceRecord,
  LoginInput,
  OrganizationMember,
  OrganizationWithRole,
  PasswordResetConfirmInput,
  RegisterInput,
  Role,
  SessionPermission,
  SessionRecord,
} from '@remote-desktop/shared';
import type {
  IceServerConfig,
  InputMessage,
  MonitorInfo,
  MonitorSelection,
} from '@remote-desktop/webrtc';

export const IPC_CHANNELS = {
  appGetInfo: 'app:get-info',
  themeSetSource: 'theme:set-source',
  authGetState: 'auth:get-state',
  authLogin: 'auth:login',
  authRegister: 'auth:register',
  authLogout: 'auth:logout',
  authRequestPasswordReset: 'auth:request-password-reset',
  authConfirmPasswordReset: 'auth:confirm-password-reset',
  devicesList: 'devices:list',
  sessionsList: 'sessions:list',
  thisDeviceGet: 'this-device:get',
  thisDeviceRegister: 'this-device:register',
  thisDeviceSettingsGet: 'this-device:settings-get',
  thisDeviceSettingsUpdate: 'this-device:settings-update',
  auditList: 'audit:list',
  teamsList: 'teams:list',
  teamsCreate: 'teams:create',
  teamsMembers: 'teams:members',
  teamsAddMember: 'teams:add-member',
  teamsUpdateMember: 'teams:update-member',
  teamsRemoveMember: 'teams:remove-member',
  sessionStart: 'session:start',
  sessionReady: 'session:ready',
  sessionSignal: 'session:signal',
  sessionReport: 'session:report',
  sessionEnd: 'session:end',
  sessionSetPermissions: 'session:set-permissions',
  signalingStatus: 'signaling:status',
  hostInput: 'host:input',
  hostReadClipboard: 'host:read-clipboard',
  hostWriteClipboard: 'host:write-clipboard',
  hostMonitors: 'host:monitors',
  hostSelectMonitor: 'host:select-monitor',
  hostSetFollow: 'host:set-follow',
  hostStartNativeCapture: 'host:start-native-capture',
  hostStopNativeCapture: 'host:stop-native-capture',
  controllerReadClipboard: 'controller:read-clipboard',
  controllerWriteClipboard: 'controller:write-clipboard',
  filesBegin: 'files:begin',
  filesChunk: 'files:chunk',
  filesFinish: 'files:finish',
  filesCancel: 'files:cancel',
  filesOpenFolder: 'files:open-folder',
} as const;

/** Main -> renderer push channels (not invokable). */
export const IPC_EVENTS = {
  session: 'session:event',
  /** Delivers a MessagePort carrying native-helper video frames (fallback capture). */
  nativeFramesPort: 'native-frames:port',
} as const;

/** window.postMessage type used by the preload to hand the native frame port to the page. */
export const NATIVE_FRAMES_MESSAGE = 'kestrel:native-frames';

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export const THEME_SOURCES = ['light', 'dark', 'system'] as const;
export type ThemeSource = (typeof THEME_SOURCES)[number];

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  isPackaged: boolean;
}

/** Errors cross the bridge as data so the renderer gets a stable code and a safe message. */
export type IpcResult<T = void> =
  { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  memberships: { organizationId: string; organizationName: string; role: Role }[];
}

export type AuthState = { status: 'signed-out' } | { status: 'signed-in'; user: AuthUser };

/** This computer's registration. The private key never leaves the main process. */
export interface ThisDevice {
  deviceId: string;
  deviceCode: string;
  name: string;
  keyFingerprint: string;
}

// ---------------------------------------------------------------------------
// Remote sessions (Phase 3)
// ---------------------------------------------------------------------------

/** This computer's server-side settings (enforced by the server, not the app). */
export interface ThisDeviceSettings {
  requireApproval: boolean;
  hasAccessPassword: boolean;
  /** The team (organisation) this computer belongs to, or null. */
  organizationId: string | null;
}

/**
 * `accessPassword`: a string sets or replaces it, null removes it.
 * `organizationId`: moves this computer into a team, or out of one with null.
 */
export interface ThisDeviceSettingsUpdate {
  requireApproval?: boolean;
  accessPassword?: string | null;
  organizationId?: string | null;
}

export type SessionRole = 'controller' | 'host';
export type SignalingStatus = 'disconnected' | 'connecting' | 'connected';
export type ReportableState = 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'FAILED';

export interface SessionPeerInfo {
  userId: string;
  displayName: string | null;
  deviceCode: string | null;
}

/** What a session window needs to start; permissions always come from the server. */
export interface SessionSnapshot {
  sessionId: string;
  role: SessionRole;
  state: string;
  permissions: SessionPermission[];
  iceServers: IceServerConfig[];
  /** Host role: who is connected. Controller role: null. */
  peer: SessionPeerInfo | null;
  /** Controller role: the device being controlled. */
  deviceCode: string | null;
  startedAt: string;
}

export type SessionSignal =
  | { kind: 'offer' | 'answer'; sdp: string }
  | {
      kind: 'ice';
      candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };
    };

export type SessionEvent =
  | { type: 'approved'; sessionId: string; permissions: SessionPermission[] }
  | { type: 'rejected'; sessionId: string; reason: string | null }
  | { type: 'ice'; sessionId: string; iceServers: IceServerConfig[] }
  | { type: 'signal'; sessionId: string; signal: SessionSignal }
  | { type: 'permissions'; sessionId: string; permissions: SessionPermission[] }
  | { type: 'ended'; sessionId: string; state: string; reason: string | null }
  | { type: 'follow'; sessionId: string; monitorId: string }
  | { type: 'activity'; sessionId: string; text: string }
  | { type: 'signaling'; status: SignalingStatus };

export interface StartSessionInput {
  deviceCode: string;
  permissions: SessionPermission[];
  accessPassword?: string;
}

export interface StartSessionResult {
  sessionId: string;
  state: string;
  autoApproved: boolean;
  targetOnline: boolean;
  permissions: SessionPermission[];
}

export interface HostMonitorsResult {
  monitors: MonitorInfo[];
  current: MonitorSelection;
  follow: boolean;
  /** False when the native helper is unavailable (view-only fallback). */
  nativeHelper: boolean;
}

export interface FileOfferInput {
  id: string;
  name: string;
  size: number;
}

/** Shape of `window.desktop`, exposed by the preload script via contextBridge. */
export interface DesktopApi {
  app: {
    getInfo(): Promise<AppInfo>;
  };
  theme: {
    /** Keeps native UI (title bar, scrollbars, dialogs) in sync with the app theme. */
    setSource(source: ThemeSource): Promise<void>;
  };
  auth: {
    /** Current state; on first call after launch this restores a saved session. */
    getState(): Promise<AuthState>;
    login(input: LoginInput): Promise<IpcResult<AuthState>>;
    /** `needsConfirmation` when the account must confirm its email before signing in. */
    register(
      input: RegisterInput,
    ): Promise<IpcResult<{ state: AuthState; needsConfirmation: boolean }>>;
    logout(): Promise<IpcResult>;
    requestPasswordReset(email: string): Promise<IpcResult>;
    confirmPasswordReset(input: PasswordResetConfirmInput): Promise<IpcResult>;
  };
  devices: {
    list(): Promise<IpcResult<DeviceRecord[]>>;
  };
  sessions: {
    list(): Promise<IpcResult<SessionRecord[]>>;
  };
  thisDevice: {
    get(): Promise<ThisDevice | null>;
    register(name: string): Promise<IpcResult<ThisDevice>>;
    /** Null when this computer is not registered. */
    getSettings(): Promise<IpcResult<ThisDeviceSettings | null>>;
    updateSettings(update: ThisDeviceSettingsUpdate): Promise<IpcResult<ThisDeviceSettings>>;
  };
  /** Teams (organisations). Every call is authorized server-side by the caller's role. */
  teams: {
    list(): Promise<IpcResult<OrganizationWithRole[]>>;
    create(input: { name: string; slug: string }): Promise<IpcResult<OrganizationWithRole>>;
    members(teamId: string): Promise<IpcResult<OrganizationMember[]>>;
    addMember(teamId: string, input: { email: string; role: Role }): Promise<IpcResult>;
    updateMember(teamId: string, userId: string, role: Role): Promise<IpcResult>;
    removeMember(teamId: string, userId: string): Promise<IpcResult>;
  };
  audit: {
    /** Activity the server lets this account see, newest first. */
    list(options?: { before?: string }): Promise<IpcResult<AuditLog[]>>;
  };
  session: {
    /** Controller: ask to connect. Approval and permissions are decided server-side. */
    start(input: StartSessionInput): Promise<IpcResult<StartSessionResult>>;
    /** The session window is ready: returns the snapshot and flushes queued events. */
    ready(sessionId: string): Promise<IpcResult<SessionSnapshot>>;
    signal(sessionId: string, signal: SessionSignal): Promise<IpcResult>;
    report(sessionId: string, state: ReportableState): Promise<IpcResult>;
    end(sessionId: string, reason?: string): Promise<IpcResult>;
    /** Host only: change what the controller may do (the server re-validates). */
    setPermissions(
      sessionId: string,
      permissions: SessionPermission[],
    ): Promise<IpcResult<SessionPermission[]>>;
    signalingStatus(): Promise<SignalingStatus>;
    onEvent(listener: (event: SessionEvent) => void): () => void;
  };
  /** Host role only. Every call is authorized by main against the session's permissions. */
  host: {
    input(sessionId: string, message: InputMessage): Promise<IpcResult>;
    readClipboard(sessionId: string): Promise<IpcResult<string>>;
    writeClipboard(sessionId: string, text: string): Promise<IpcResult>;
    monitors(sessionId: string): Promise<IpcResult<HostMonitorsResult>>;
    /** Prepares the capture source(s) that the next getDisplayMedia call(s) will receive. */
    selectMonitor(
      sessionId: string,
      selection: MonitorSelection,
    ): Promise<IpcResult<{ captures: number }>>;
    setFollow(sessionId: string, enabled: boolean): Promise<IpcResult>;
    startNativeCapture(
      sessionId: string,
      options: { monitorId: string; maxFps: number; maxWidth: number },
    ): Promise<IpcResult>;
    stopNativeCapture(sessionId: string): Promise<IpcResult>;
  };
  /** Controller role only: the controller's own clipboard, for explicit transfers. */
  controller: {
    readClipboard(sessionId: string): Promise<IpcResult<string>>;
    writeClipboard(sessionId: string, text: string): Promise<IpcResult>;
  };
  /** Receiving files. Main picks the folder and the final name. */
  files: {
    begin(sessionId: string, offer: FileOfferInput): Promise<IpcResult<{ name: string }>>;
    chunk(sessionId: string, id: string, data: Uint8Array): Promise<IpcResult>;
    finish(sessionId: string, id: string, sha256: string): Promise<IpcResult<{ name: string }>>;
    cancel(sessionId: string, id: string): Promise<IpcResult>;
    openFolder(): Promise<IpcResult>;
  };
}
