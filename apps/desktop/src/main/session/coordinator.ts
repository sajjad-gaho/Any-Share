/**
 * Session coordinator (main process).
 *
 * Owns every remote session on this computer, in either role:
 *   controller — this user is viewing/controlling another device;
 *   host       — another user is viewing/controlling this device.
 *
 * Security model
 *   * Permissions come only from the signaling server (approval acks,
 *     permission updates, periodic verify). Nothing the renderer or the peer
 *     sends can widen them.
 *   * Every IPC call names a session and must come from the window that owns
 *     it; host-only operations require the host role.
 *   * Native operations (input, clipboard, capture) happen only here, after
 *     checking permissions, via the helper's fixed command set.
 *   * Host sessions are always visible (indicator window) and re-verified
 *     with the server every 30 s; if verification fails repeatedly the
 *     session ends locally.
 */
import { join } from 'node:path';
import { sessionPermissionSchema, type SessionPermission } from '@remote-desktop/shared';
import { PERMISSION_LABELS } from '@remote-desktop/shared';
import type {
  IceServerConfig,
  InputMessage,
  MonitorSelection,
  ServerMessage,
} from '@remote-desktop/webrtc';
import {
  BrowserWindow,
  MessageChannelMain,
  app,
  clipboard,
  desktopCapturer,
  dialog,
  screen,
  shell,
  type DesktopCapturerSource,
  type MessagePortMain,
  type WebContents,
} from 'electron';
import { z } from 'zod';
import type {
  HostMonitorsResult,
  ReportableState,
  SessionEvent,
  SessionPeerInfo,
  SessionSignal,
  SessionSnapshot,
  SignalingStatus,
  StartSessionInput,
  StartSessionResult,
} from '../../shared/ipc';
import { IPC_EVENTS } from '../../shared/ipc';
import type { AuthSession } from '../backend/auth-session';
import type { DeviceIdentity } from '../backend/device-identity';
import { HelperClient, HelperError } from '../native/helper-client';
import type { NativeMonitor } from '../native/protocol';
import { areaOf, matchDisplays, monitorAt, toMonitorInfo, type PhysicalDisplay } from './displays';
import { FileSink, FileTransferError } from './file-sink';
import {
  authorizeInput,
  boundingArea,
  canTransferFiles,
  canUseClipboard,
  type CaptureArea,
} from './policy';
import { SignalingClient, SignalingError } from './signaling-client';

export class SessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

const VERIFY_INTERVAL_MS = 30_000;
/** Consecutive failed verifications before a host session ends on its own. */
const MAX_VERIFY_FAILURES = 3;
const FOLLOW_POLL_MS = 400;
/** Upper bound on injected input events per second per session. */
const MAX_INPUT_PER_SECOND = 500;
const ICE_CACHE_TTL_MS = 120_000;

interface BaseSession {
  id: string;
  state: string;
  permissions: SessionPermission[];
  iceServers: IceServerConfig[];
  owner: WebContents | null;
  ready: boolean;
  queue: SessionEvent[];
  startedAt: string;
  files: FileSink;
  /** transfer id -> size, for audit events */
  transfers: Map<string, number>;
}

interface ControllerSession extends BaseSession {
  role: 'controller';
  deviceCode: string;
}

interface HostSession extends BaseSession {
  role: 'host';
  peer: SessionPeerInfo;
  window: BrowserWindow | null;
  monitors: NativeMonitor[];
  displayIds: Map<string, string | null>;
  selection: MonitorSelection;
  area: CaptureArea | null;
  /** Capture sources handed out to the next getDisplayMedia calls, in order. */
  pendingSources: DesktopCapturerSource[];
  follow: boolean;
  followTimer: NodeJS.Timeout | null;
  verifyTimer: NodeJS.Timeout | null;
  verifyFailures: number;
  inputWindow: { second: number; count: number };
  nativePort: MessagePortMain | null;
}

type Session = ControllerSession | HostSession;

const peerSchema = z.object({
  userId: z.uuid(),
  displayName: z.string().nullable(),
  deviceCode: z.string().nullable(),
});

export interface CoordinatorDeps {
  signalingUrl: string | null;
  auth: AuthSession;
  device: DeviceIdentity;
  helperPath: string;
  rendererUrl: () => string;
  preloadPath: string;
  mainWindow: () => BrowserWindow | null;
}

export class SessionCoordinator {
  private readonly sessions = new Map<string, Session>();
  private readonly iceCache = new Map<string, { iceServers: IceServerConfig[]; at: number }>();
  private readonly signaling: SignalingClient | null;
  private helper: HelperClient | null = null;
  private helperStarting: Promise<HelperClient | null> | null = null;
  private readonly statusListeners = new Set<WebContents>();

  constructor(private readonly deps: CoordinatorDeps) {
    this.signaling = deps.signalingUrl
      ? new SignalingClient(deps.signalingUrl, () => this.identity())
      : null;
    this.signaling?.on('message', (message) => void this.onServerMessage(message));
    this.signaling?.on('status', (status) => this.broadcastStatus(status));
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  /** Connect to signaling while signed in; disconnect (ending sessions) when not. */
  onAuthChanged(signedIn: boolean): void {
    if (!this.signaling) return;
    if (signedIn) {
      this.signaling.start();
    } else {
      this.signaling.stop('signed out');
      for (const id of [...this.sessions.keys()]) void this.teardown(id, 'ENDED', 'signed_out');
    }
  }

  /** Reconnect so the socket carries this device's identity (can now receive requests). */
  onDeviceRegistered(): void {
    this.signaling?.restart();
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.endSession(id, 'app_closed').catch(() => undefined);
    }
    this.signaling?.stop('app quitting');
    await this.helper?.shutdown();
  }

  signalingStatus(): SignalingStatus {
    if (!this.signaling) return 'disconnected';
    return this.signaling.connected ? 'connected' : 'disconnected';
  }

  subscribeStatus(contents: WebContents): void {
    this.statusListeners.add(contents);
    contents.once('destroyed', () => this.statusListeners.delete(contents));
  }

  private broadcastStatus(status: SignalingStatus): void {
    for (const contents of this.statusListeners) {
      if (!contents.isDestroyed()) {
        contents.send(IPC_EVENTS.session, { type: 'signaling', status } satisfies SessionEvent);
      }
    }
  }

  private async identity() {
    const accessToken = await this.deps.auth.accessToken();
    if (!accessToken) return null;
    const device = await this.deps.device.get();
    return {
      accessToken,
      device: device
        ? { deviceId: device.deviceId, sign: (message: string) => this.deps.device.sign(message) }
        : null,
    };
  }

  private requireSignaling(): SignalingClient {
    if (!this.signaling) {
      throw new SessionError(
        'not_configured',
        'This build is not connected to a signaling server.',
      );
    }
    return this.signaling;
  }

  // -------------------------------------------------------------------------
  // session lookup and event delivery
  // -------------------------------------------------------------------------

  /** The session, if `sender` is the window that owns it. Otherwise "not found". */
  private owned(sender: WebContents, sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session || session.owner?.id !== sender.id) {
      throw new SessionError('not_found', 'No such session');
    }
    return session;
  }

  private ownedHost(sender: WebContents, sessionId: string): HostSession {
    const session = this.owned(sender, sessionId);
    if (session.role !== 'host') throw new SessionError('forbidden', 'Host sessions only');
    return session;
  }

  private emit(session: Session, event: SessionEvent): void {
    if (!session.ready || !session.owner || session.owner.isDestroyed()) {
      session.queue.push(event);
      return;
    }
    session.owner.send(IPC_EVENTS.session, event);
  }

  private snapshot(session: Session): SessionSnapshot {
    return {
      sessionId: session.id,
      role: session.role,
      state: session.state,
      permissions: [...session.permissions],
      iceServers: session.iceServers,
      peer: session.role === 'host' ? session.peer : null,
      deviceCode: session.role === 'controller' ? session.deviceCode : null,
      startedAt: session.startedAt,
    };
  }

  ready(sender: WebContents, sessionId: string): SessionSnapshot {
    const session = this.owned(sender, sessionId);
    session.ready = true;
    const queued = session.queue.splice(0);
    queueMicrotask(() => {
      for (const event of queued) this.emit(session, event);
    });
    return this.snapshot(session);
  }

  private takeIce(sessionId: string): IceServerConfig[] {
    const cached = this.iceCache.get(sessionId);
    this.iceCache.delete(sessionId);
    return cached && Date.now() - cached.at < ICE_CACHE_TTL_MS ? cached.iceServers : [];
  }

  private newFileSink(): FileSink {
    return new FileSink(join(app.getPath('downloads'), 'Kestrel Remote'));
  }

  // -------------------------------------------------------------------------
  // controller role
  // -------------------------------------------------------------------------

  async start(sender: WebContents, input: StartSessionInput): Promise<StartSessionResult> {
    const signaling = this.requireSignaling();
    const ack = await signaling.request('connection.request', {
      targetDeviceCode: input.deviceCode,
      permissions: input.permissions,
      accessPassword: input.accessPassword,
    });
    const sessionId = z.uuid().parse(ack['sessionId']);
    const autoApproved = ack['autoApproved'] === true;
    const permissions = sessionPermissionSchema.array().parse(ack['permissions']);
    const session: ControllerSession = {
      id: sessionId,
      role: 'controller',
      state: String(ack['state']),
      // Requested permissions are not granted until the server says so.
      permissions: autoApproved ? permissions : [],
      iceServers: this.takeIce(sessionId),
      owner: sender,
      ready: false,
      queue: [],
      startedAt: new Date().toISOString(),
      files: this.newFileSink(),
      transfers: new Map(),
      deviceCode: input.deviceCode,
    };
    this.sessions.set(sessionId, session);
    sender.once(
      'destroyed',
      () => void this.endSession(sessionId, 'window_closed').catch(() => undefined),
    );
    if (autoApproved) this.emit(session, { type: 'approved', sessionId, permissions });
    return {
      sessionId,
      state: session.state,
      autoApproved,
      targetOnline: ack['targetOnline'] === true,
      permissions,
    };
  }

  async readLocalClipboard(sender: WebContents, sessionId: string): Promise<string> {
    const session = this.owned(sender, sessionId);
    if (session.role !== 'controller' || !canUseClipboard(session.permissions)) {
      throw new SessionError('forbidden', 'Clipboard transfer is not permitted in this session');
    }
    // Electron 44+: the clipboard API is asynchronous (awaiting also suits older sync versions).
    return (await clipboard.readText()).slice(0, 256 * 1024);
  }

  async writeLocalClipboard(sender: WebContents, sessionId: string, text: string): Promise<void> {
    const session = this.owned(sender, sessionId);
    if (session.role !== 'controller' || !canUseClipboard(session.permissions)) {
      throw new SessionError('forbidden', 'Clipboard transfer is not permitted in this session');
    }
    await clipboard.writeText(text);
    // Not audited here: the host side records every clipboard transfer once.
  }

  // -------------------------------------------------------------------------
  // both roles
  // -------------------------------------------------------------------------

  async signal(sender: WebContents, sessionId: string, signal: SessionSignal): Promise<void> {
    const session = this.owned(sender, sessionId);
    const signaling = this.requireSignaling();
    if (signal.kind === 'ice') {
      await signaling.request('webrtc.ice_candidate', {
        sessionId: session.id,
        candidate: signal.candidate,
      });
    } else if (signal.kind === 'offer') {
      if (session.role !== 'controller')
        throw new SessionError('forbidden', 'Only the controller offers');
      await signaling.request('webrtc.offer', { sessionId: session.id, sdp: signal.sdp });
    } else {
      if (session.role !== 'host') throw new SessionError('forbidden', 'Only the host answers');
      await signaling.request('webrtc.answer', { sessionId: session.id, sdp: signal.sdp });
    }
  }

  async report(sender: WebContents, sessionId: string, state: ReportableState): Promise<void> {
    const session = this.owned(sender, sessionId);
    if (session.role !== 'controller') return;
    const ack = await this.requireSignaling().request('session.report', { sessionId, state });
    session.state = String(ack['state']);
  }

  async end(sender: WebContents, sessionId: string, reason?: string): Promise<void> {
    this.owned(sender, sessionId);
    await this.endSession(sessionId, reason ?? 'ended_by_user');
  }

  private async endSession(sessionId: string, reason: string): Promise<void> {
    if (!this.sessions.has(sessionId)) return;
    try {
      await this.signaling?.request('session.end', { sessionId, reason }, 5_000);
    } catch {
      // Ending locally must never depend on the network.
    }
    await this.teardown(sessionId, 'ENDED', reason);
  }

  /** Host only: change the controller's permissions. The server intersects with its ceiling. */
  async setPermissions(
    sender: WebContents,
    sessionId: string,
    permissions: SessionPermission[],
  ): Promise<SessionPermission[]> {
    const session = this.ownedHost(sender, sessionId);
    const ack = await this.requireSignaling().request('session.permission_update', {
      sessionId,
      permissions,
    });
    const granted = sessionPermissionSchema.array().parse(ack['permissions']);
    await this.applyPermissions(session, granted);
    return granted;
  }

  private async applyPermissions(
    session: Session,
    permissions: SessionPermission[],
  ): Promise<void> {
    const lostControl =
      session.permissions.includes('remote_control') && !permissions.includes('remote_control');
    session.permissions = permissions;
    if (session.role === 'host' && lostControl) {
      await this.helper?.request({ cmd: 'RELEASE_ALL_INPUT' }).catch(() => undefined);
    }
    this.emit(session, { type: 'permissions', sessionId: session.id, permissions });
  }

  // -------------------------------------------------------------------------
  // host role: approval and window
  // -------------------------------------------------------------------------

  private async promptApproval(request: {
    requestId: string;
    controller: SessionPeerInfo;
    permissions: SessionPermission[];
    message: string | null;
    expiresAt: string;
  }): Promise<'allow' | 'view' | 'reject'> {
    const controller = new AbortController();
    const ttl = Math.max(0, Date.parse(request.expiresAt) - Date.now());
    const timer = setTimeout(() => controller.abort(), ttl);
    const who = request.controller.displayName ?? 'Someone';
    const from = request.controller.deviceCode
      ? ` from device ${request.controller.deviceCode}`
      : '';
    const parent = this.deps.mainWindow();
    if (parent?.isMinimized()) parent.restore();
    parent?.flashFrame(true);
    const options = {
      type: 'question' as const,
      title: 'Remote connection request',
      message: `${who}${from} wants to connect to this computer.`,
      detail: [
        `Requested: ${request.permissions.map((p) => PERMISSION_LABELS[p]).join(', ')}`,
        request.message ? `Message: "${request.message}"` : null,
        '',
        'Only allow this if you know this person and expect their help.',
        'You will see a "Remote session active" window and can end the session at any time.',
      ]
        .filter((line) => line !== null)
        .join('\n'),
      buttons: ['Reject', 'Allow view only', 'Allow'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      signal: controller.signal,
    };
    try {
      const result = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
      if (controller.signal.aborted) return 'reject';
      return result.response === 2 ? 'allow' : result.response === 1 ? 'view' : 'reject';
    } finally {
      clearTimeout(timer);
      parent?.flashFrame(false);
    }
  }

  private async onConnectionRequest(
    payload: Extract<ServerMessage, { type: 'connection.request' }>['payload'],
  ) {
    const signaling = this.signaling;
    if (!signaling) return;
    const decision = await this.promptApproval({
      requestId: payload.requestId,
      controller: payload.controller,
      permissions: payload.permissions,
      message: payload.message,
      expiresAt: payload.expiresAt,
    });
    if (decision === 'reject') {
      await signaling
        .request('connection.reject', { requestId: payload.requestId, reason: 'rejected_by_user' })
        .catch(() => undefined);
      return;
    }
    try {
      const ack = await signaling.request('connection.approve', {
        requestId: payload.requestId,
        permissions: decision === 'view' ? ['screen_view'] : undefined,
      });
      const permissions = sessionPermissionSchema.array().parse(ack['permissions']);
      await this.openHostSession(payload.sessionId, permissions, payload.controller);
    } catch (error) {
      console.error('Approving the connection failed', (error as Error).message);
    }
  }

  private async openHostSession(
    sessionId: string,
    permissions: SessionPermission[],
    peer: SessionPeerInfo,
  ): Promise<void> {
    if (this.sessions.has(sessionId)) return;
    const session: HostSession = {
      id: sessionId,
      role: 'host',
      state: 'SIGNALING',
      permissions,
      iceServers: this.takeIce(sessionId),
      owner: null,
      ready: false,
      queue: [],
      startedAt: new Date().toISOString(),
      files: this.newFileSink(),
      transfers: new Map(),
      peer,
      window: null,
      monitors: [],
      displayIds: new Map(),
      selection: 'primary',
      area: null,
      pendingSources: [],
      follow: false,
      followTimer: null,
      verifyTimer: null,
      verifyFailures: 0,
      inputWindow: { second: 0, count: 0 },
      nativePort: null,
    };
    this.sessions.set(sessionId, session);
    await this.loadMonitors(session);
    const window = this.createIndicatorWindow(session);
    session.window = window;
    session.owner = window.webContents;
    session.verifyTimer = setInterval(() => void this.verify(session), VERIFY_INTERVAL_MS);
  }

  /**
   * The always-visible "REMOTE SESSION ACTIVE" window. It hosts the peer
   * connection and capture, cannot be minimised or hidden, and closing it
   * ends the session.
   */
  private createIndicatorWindow(session: HostSession): BrowserWindow {
    const { workArea } = screen.getPrimaryDisplay();
    const width = 400;
    const window = new BrowserWindow({
      title: 'Remote session active',
      width,
      height: 340,
      x: workArea.x + workArea.width - width - 16,
      y: workArea.y + 16,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: false,
      autoHideMenuBar: true,
      backgroundColor: '#7f1d1d',
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        // DevTools only in development builds.
        devTools: !app.isPackaged,
        spellcheck: false,
        // A background-throttled host would stall capture and input.
        backgroundThrottling: false,
      },
    });
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setMenuBarVisibility(false);
    window.on('close', (event) => {
      if (this.sessions.has(session.id)) {
        // Closing the indicator is how the remote user ends the session.
        event.preventDefault();
        void this.endSession(session.id, 'ended_by_remote_user');
      }
    });
    const url = new URL(this.deps.rendererUrl());
    url.hash = `#/host-session/${session.id}`;
    void window.loadURL(url.toString());
    return window;
  }

  // -------------------------------------------------------------------------
  // host role: verification (short-lived authorization)
  // -------------------------------------------------------------------------

  private async verify(session: HostSession): Promise<void> {
    if (!this.sessions.has(session.id)) return;
    try {
      const ack = await this.requireSignaling().request('session.verify', {
        sessionId: session.id,
      });
      session.verifyFailures = 0;
      if (ack['ended'] === true) {
        await this.teardown(session.id, String(ack['state'] ?? 'ENDED'), 'authorization_ended');
        return;
      }
      const permissions = sessionPermissionSchema.array().parse(ack['permissions']);
      if (permissions.join() !== session.permissions.join())
        await this.applyPermissions(session, permissions);
      const iceServers = z
        .array(
          z.object({
            urls: z.union([z.string(), z.array(z.string())]),
            username: z.string().optional(),
            credential: z.string().optional(),
          }),
        )
        .safeParse(ack['iceServers']);
      if (iceServers.success && iceServers.data.length > 0) {
        session.iceServers = iceServers.data;
        this.emit(session, { type: 'ice', sessionId: session.id, iceServers: iceServers.data });
      }
    } catch (error) {
      const code = error instanceof SignalingError ? error.code : 'error';
      if (code === 'not_found' || code === 'invalid_state') {
        await this.teardown(session.id, 'ENDED', 'authorization_ended');
        return;
      }
      session.verifyFailures += 1;
      if (session.verifyFailures >= MAX_VERIFY_FAILURES) {
        await this.teardown(session.id, 'FAILED', 'authorization_lapsed');
      }
    }
  }

  // -------------------------------------------------------------------------
  // host role: monitors and capture
  // -------------------------------------------------------------------------

  private async ensureHelper(): Promise<HelperClient | null> {
    if (this.helper?.alive) return this.helper;
    this.helperStarting ??= HelperClient.start(this.deps.helperPath)
      .then((client) => {
        this.helper = client;
        client.on('exit', () => {
          if (this.helper === client) this.helper = null;
        });
        client.on('frame', (header, pixels) => {
          for (const session of this.sessions.values()) {
            if (session.role === 'host' && session.nativePort) {
              session.nativePort.postMessage({ header, pixels: new Uint8Array(pixels) });
            }
          }
        });
        return client;
      })
      .catch((error: unknown) => {
        console.error('Native helper unavailable', (error as Error).message);
        return null;
      })
      .finally(() => {
        this.helperStarting = null;
      });
    return this.helperStarting;
  }

  private physicalDisplays(): PhysicalDisplay[] {
    return screen.getAllDisplays().map((display) => ({
      id: String(display.id),
      rect: screen.dipToScreenRect(null, display.bounds),
      scaleFactor: display.scaleFactor,
    }));
  }

  private async loadMonitors(session: HostSession): Promise<void> {
    const helper = await this.ensureHelper();
    let monitors: NativeMonitor[] = [];
    if (helper) {
      monitors = await helper.monitors().catch(() => []);
    }
    if (monitors.length === 0) {
      // Fallback without the helper: Electron's view of the displays.
      const primaryId = screen.getPrimaryDisplay().id;
      monitors = screen.getAllDisplays().map((display, index) => {
        const rect = screen.dipToScreenRect(null, display.bounds);
        return {
          id: `display-${display.id}`,
          name: `Display ${index + 1}`,
          primary: display.id === primaryId,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          scaleFactor: display.scaleFactor,
          refreshHz: Math.round(display.displayFrequency),
        };
      });
    }
    session.monitors = monitors;
    session.displayIds = new Map(
      matchDisplays(monitors, this.physicalDisplays()).map((t) => [t.monitor.id, t.displayId]),
    );
    const primary = monitors.find((m) => m.primary) ?? monitors[0];
    session.selection = primary?.id ?? 'all';
    session.area = primary ? areaOf(primary) : null;
  }

  async monitors(sender: WebContents, sessionId: string): Promise<HostMonitorsResult> {
    const session = this.ownedHost(sender, sessionId);
    return {
      monitors: session.monitors.map(toMonitorInfo),
      current: session.selection,
      follow: session.follow,
      nativeHelper: Boolean(this.helper?.alive),
    };
  }

  /**
   * Chooses what the next getDisplayMedia call(s) of this host window will
   * capture. The renderer can only pick among this computer's monitors and
   * the sources are resolved here, so it can never capture anything else.
   */
  async selectMonitor(
    sender: WebContents,
    sessionId: string,
    selection: MonitorSelection,
  ): Promise<number> {
    const session = this.ownedHost(sender, sessionId);
    if (!session.permissions.includes('screen_view')) {
      throw new SessionError('forbidden', 'Screen view is not permitted');
    }
    const targets =
      selection === 'all' ? session.monitors : session.monitors.filter((m) => m.id === selection);
    if (targets.length === 0) throw new SessionError('invalid', 'Unknown monitor');
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    const pending: DesktopCapturerSource[] = [];
    for (const monitor of targets) {
      const displayId = session.displayIds.get(monitor.id);
      const source =
        sources.find((s) => displayId && s.display_id === displayId) ??
        (targets.length === 1 && sources.length === 1 ? sources[0] : undefined);
      if (!source) throw new SessionError('capture_unavailable', `Cannot capture ${monitor.name}`);
      pending.push(source);
    }
    session.pendingSources = pending;
    session.selection = selection;
    session.area =
      selection === 'all' ? boundingArea(targets.map(areaOf)) : areaOf(targets[0] as NativeMonitor);
    return pending.length;
  }

  /** Electron display-media handler: only host windows with a prepared source get a stream. */
  handleDisplayMediaRequest(
    contents: WebContents | null,
    callback: (streams: { video?: DesktopCapturerSource }) => void,
  ): void {
    const session = [...this.sessions.values()].find(
      (s): s is HostSession => s.role === 'host' && s.owner !== null && s.owner.id === contents?.id,
    );
    const source = session?.permissions.includes('screen_view')
      ? session.pendingSources.shift()
      : undefined;
    callback(source ? { video: source } : {});
  }

  /** Permission handlers ask this before granting media/display capture to a renderer. */
  isCaptureAllowed(contents: WebContents | null): boolean {
    if (!contents) return false;
    for (const session of this.sessions.values()) {
      if (session.role === 'host' && session.owner?.id === contents.id) {
        return session.permissions.includes('screen_view');
      }
    }
    return false;
  }

  setFollow(sender: WebContents, sessionId: string, enabled: boolean): void {
    const session = this.ownedHost(sender, sessionId);
    session.follow = enabled;
    if (session.followTimer) clearInterval(session.followTimer);
    session.followTimer = null;
    if (!enabled) return;
    session.followTimer = setInterval(() => {
      if (session.selection === 'all') return;
      const point = screen.dipToScreenPoint(screen.getCursorScreenPoint());
      const monitor = monitorAt(session.monitors, point.x, point.y);
      if (monitor && monitor.id !== session.selection) {
        this.emit(session, { type: 'follow', sessionId, monitorId: monitor.id });
      }
    }, FOLLOW_POLL_MS);
  }

  /** Fallback video path: frames from the helper's DXGI capture, over a MessagePort. */
  async startNativeCapture(
    sender: WebContents,
    sessionId: string,
    options: { monitorId: string; maxFps: number; maxWidth: number },
  ): Promise<void> {
    const session = this.ownedHost(sender, sessionId);
    if (!session.permissions.includes('screen_view'))
      throw new SessionError('forbidden', 'Screen view is not permitted');
    const monitor = session.monitors.find((m) => m.id === options.monitorId);
    if (!monitor) throw new SessionError('invalid', 'Unknown monitor');
    const helper = await this.ensureHelper();
    if (!helper) throw new SessionError('helper_unavailable', 'The native helper is not available');
    session.nativePort?.close();
    const { port1, port2 } = new MessageChannelMain();
    session.nativePort = port1;
    sender.postMessage(IPC_EVENTS.nativeFramesPort, null, [port2]);
    session.selection = monitor.id;
    session.area = areaOf(monitor);
    await helper.request({
      cmd: 'START_CAPTURE',
      args: { monitorId: monitor.id, maxFps: options.maxFps, maxWidth: options.maxWidth },
    });
  }

  async stopNativeCapture(sender: WebContents, sessionId: string): Promise<void> {
    const session = this.ownedHost(sender, sessionId);
    session.nativePort?.close();
    session.nativePort = null;
    await this.helper?.request({ cmd: 'STOP_CAPTURE' }).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // host role: input and clipboard
  // -------------------------------------------------------------------------

  async input(sender: WebContents, sessionId: string, message: InputMessage): Promise<void> {
    const session = this.ownedHost(sender, sessionId);
    const second = Math.floor(Date.now() / 1000);
    if (session.inputWindow.second !== second) session.inputWindow = { second, count: 0 };
    if (++session.inputWindow.count > MAX_INPUT_PER_SECOND) {
      throw new SessionError('rate_limited', 'Too much input');
    }
    const decision = authorizeInput(message, session.permissions, session.area);
    if (!decision.allowed) throw new SessionError('forbidden', decision.reason);
    const helper = await this.ensureHelper();
    if (!helper)
      throw new SessionError(
        'helper_unavailable',
        'Remote input is not available on this computer',
      );
    for (const command of decision.commands) {
      await helper.request(command);
    }
  }

  async readHostClipboard(sender: WebContents, sessionId: string): Promise<string> {
    const session = this.ownedHost(sender, sessionId);
    if (!canUseClipboard(session.permissions)) {
      throw new SessionError('forbidden', 'Clipboard transfer is not permitted');
    }
    const helper = await this.ensureHelper();
    const text = helper ? await helper.clipboardText() : await clipboard.readText();
    this.emit(session, {
      type: 'activity',
      sessionId,
      text: 'Your clipboard text was sent to the remote user.',
    });
    await this.audit(
      session,
      'CLIPBOARD_TRANSFERRED',
      'host_to_controller',
      Buffer.byteLength(text),
    );
    return text;
  }

  async writeHostClipboard(sender: WebContents, sessionId: string, text: string): Promise<void> {
    const session = this.ownedHost(sender, sessionId);
    if (!canUseClipboard(session.permissions)) {
      throw new SessionError('forbidden', 'Clipboard transfer is not permitted');
    }
    const helper = await this.ensureHelper();
    if (helper) await helper.request({ cmd: 'SET_CLIPBOARD', args: { text } });
    else await clipboard.writeText(text);
    this.emit(session, {
      type: 'activity',
      sessionId,
      text: 'The remote user placed text on your clipboard.',
    });
    await this.audit(
      session,
      'CLIPBOARD_TRANSFERRED',
      'controller_to_host',
      Buffer.byteLength(text),
    );
  }

  // -------------------------------------------------------------------------
  // files (receiving side, both roles)
  // -------------------------------------------------------------------------

  private direction(session: Session): 'controller_to_host' | 'host_to_controller' {
    return session.role === 'host' ? 'controller_to_host' : 'host_to_controller';
  }

  async fileBegin(
    sender: WebContents,
    sessionId: string,
    offer: { id: string; name: string; size: number },
  ) {
    const session = this.owned(sender, sessionId);
    if (!canTransferFiles(session.permissions)) {
      throw new SessionError('forbidden', 'File transfer is not permitted in this session');
    }
    const result = await session.files.begin(offer.id, offer.name, offer.size);
    session.transfers.set(offer.id, offer.size);
    await this.audit(session, 'FILE_TRANSFER_STARTED', this.direction(session), offer.size);
    return result;
  }

  async fileChunk(
    sender: WebContents,
    sessionId: string,
    id: string,
    data: Uint8Array,
  ): Promise<void> {
    const session = this.owned(sender, sessionId);
    if (!canTransferFiles(session.permissions)) {
      await session.files.cancel(id);
      throw new SessionError('forbidden', 'File transfer is no longer permitted');
    }
    await session.files.write(id, data);
  }

  async fileFinish(sender: WebContents, sessionId: string, id: string, sha256: string) {
    const session = this.owned(sender, sessionId);
    const received = await session.files.finish(id, sha256);
    session.transfers.delete(id);
    await this.audit(
      session,
      'FILE_TRANSFER_COMPLETED',
      this.direction(session),
      received.bytes,
      received.sha256,
    );
    if (session.role === 'host') {
      this.emit(session, {
        type: 'activity',
        sessionId,
        text: `Received file "${received.name}" (saved to Downloads\\Kestrel Remote).`,
      });
    }
    return { name: received.name };
  }

  async fileCancel(sender: WebContents, sessionId: string, id: string): Promise<void> {
    const session = this.owned(sender, sessionId);
    if (await session.files.cancel(id)) {
      await this.audit(
        session,
        'FILE_TRANSFER_CANCELLED',
        this.direction(session),
        session.transfers.get(id) ?? 0,
      );
      session.transfers.delete(id);
    }
  }

  async openDownloadFolder(): Promise<void> {
    const folder = join(app.getPath('downloads'), 'Kestrel Remote');
    await shell.openPath(folder);
  }

  private async audit(
    session: Session,
    event:
      | 'FILE_TRANSFER_STARTED'
      | 'FILE_TRANSFER_COMPLETED'
      | 'FILE_TRANSFER_CANCELLED'
      | 'CLIPBOARD_TRANSFERRED',
    direction: 'controller_to_host' | 'host_to_controller',
    bytes: number,
    sha256?: string,
  ): Promise<void> {
    await this.signaling
      ?.request('session.audit', { sessionId: session.id, event, direction, bytes, sha256 })
      .catch((error: unknown) =>
        console.warn('Audit event not recorded', (error as Error).message),
      );
  }

  // -------------------------------------------------------------------------
  // server messages
  // -------------------------------------------------------------------------

  private async onServerMessage(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case 'connection.request':
        await this.onConnectionRequest(message.payload);
        return;
      case 'connection.approve': {
        const { sessionId, permissions, controller } = message.payload;
        const session = this.sessions.get(sessionId);
        if (session?.role === 'controller') {
          session.permissions = permissions;
          session.state = 'SIGNALING';
          this.emit(session, { type: 'approved', sessionId, permissions });
        } else if (!session && controller) {
          // Auto-approved (owner connecting from another device): still fully visible.
          await this.openHostSession(sessionId, permissions, peerSchema.parse(controller));
        }
        return;
      }
      case 'connection.reject': {
        const session = this.sessions.get(message.payload.sessionId);
        if (session?.role === 'controller') {
          this.emit(session, {
            type: 'rejected',
            sessionId: session.id,
            reason: message.payload.reason,
          });
          await this.teardown(session.id, 'FAILED', 'rejected', false);
        }
        return;
      }
      case 'session.ice_config': {
        const { sessionId, iceServers } = message.payload;
        const session = this.sessions.get(sessionId);
        if (session) {
          session.iceServers = iceServers;
          this.emit(session, { type: 'ice', sessionId, iceServers });
        } else {
          this.iceCache.set(sessionId, { iceServers, at: Date.now() });
        }
        return;
      }
      case 'webrtc.offer':
      case 'webrtc.answer':
      case 'webrtc.ice_candidate': {
        const session = this.sessions.get(message.payload.sessionId);
        if (!session) return;
        const signal: SessionSignal =
          message.type === 'webrtc.ice_candidate'
            ? { kind: 'ice', candidate: message.payload.candidate }
            : {
                kind: message.type === 'webrtc.offer' ? 'offer' : 'answer',
                sdp: message.payload.sdp,
              };
        // The server already enforces direction; check again locally.
        if (signal.kind === 'offer' && session.role !== 'host') return;
        if (signal.kind === 'answer' && session.role !== 'controller') return;
        this.emit(session, { type: 'signal', sessionId: session.id, signal });
        return;
      }
      case 'session.permission_update': {
        const session = this.sessions.get(message.payload.sessionId);
        if (session) await this.applyPermissions(session, message.payload.permissions);
        return;
      }
      case 'session.end': {
        const { sessionId, state, reason } = message.payload;
        if (this.sessions.has(sessionId))
          await this.teardown(sessionId, state, reason ?? 'ended_by_peer');
        return;
      }
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // teardown
  // -------------------------------------------------------------------------

  /**
   * Releases everything a session holds: injected input, native capture,
   * partial files, timers, the indicator window. Idempotent.
   */
  private async teardown(
    sessionId: string,
    state: string,
    reason: string,
    notify = true,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    if (notify) this.emit(session, { type: 'ended', sessionId, state, reason });
    await session.files.cancelAll().catch(() => undefined);
    if (session.role === 'host') {
      if (session.verifyTimer) clearInterval(session.verifyTimer);
      if (session.followTimer) clearInterval(session.followTimer);
      session.pendingSources = [];
      session.nativePort?.close();
      session.nativePort = null;
      await this.helper?.request({ cmd: 'RELEASE_ALL_INPUT' }).catch(() => undefined);
      await this.helper?.request({ cmd: 'STOP_CAPTURE' }).catch(() => undefined);
      const window = session.window;
      // Let the indicator show "session ended" briefly, then close it.
      setTimeout(() => {
        if (window && !window.isDestroyed()) window.destroy();
      }, 2_500);
      const otherHosts = [...this.sessions.values()].some((s) => s.role === 'host');
      if (!otherHosts) {
        const helper = this.helper;
        this.helper = null;
        await helper?.shutdown();
      }
    }
  }
}

export { HelperError, FileTransferError };
