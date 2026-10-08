/**
 * Controller side of a remote session (runs in the viewer page).
 *
 * The controller is the only side that makes offers. Video is receive-only;
 * four DataChannels carry control, input, clipboard and files. Everything the
 * controller sends is a request: the host re-checks permissions in its main
 * process before anything touches the remote machine.
 */
import type { SessionPermission } from '@remote-desktop/shared';
import {
  DATA_CHANNELS,
  parseChannelMessage,
  type ControlMessage,
  type InputMessage,
  type MonitorInfo,
  type MonitorSelection,
  type QualityPreset,
} from '@remote-desktop/webrtc';
import type {
  DesktopApi,
  SessionEvent,
  SessionSignal,
  StartSessionInput,
} from '../../../shared/ipc';
import { FileTransferChannel, type TransferProgress } from './file-transfer';
import { InboundStatsTracker, type SessionStats } from './stats';

export type ViewerPhase =
  | 'requesting'
  | 'awaiting-approval'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'ended'
  | 'failed';

export interface ControllerCallbacks {
  onPhase(phase: ViewerPhase, detail?: string): void;
  onStream(stream: MediaStream): void;
  onStats(stats: SessionStats): void;
  onMonitors(monitors: MonitorInfo[], current: MonitorSelection, follow: boolean): void;
  onPermissions(permissions: SessionPermission[]): void;
  onTransfer(progress: TransferProgress): void;
  onQuality(info: {
    preset: QualityPreset;
    level: number;
    width: number;
    height: number;
    fps: number;
  }): void;
  onNotice(text: string): void;
}

/** Prefer H.264 (hardware encoders on Windows), then VP8/VP9; keep RTX/FEC entries. */
function preferHardwareFriendlyCodecs(transceiver: RTCRtpTransceiver): void {
  const capabilities = RTCRtpReceiver.getCapabilities('video');
  if (!capabilities || typeof transceiver.setCodecPreferences !== 'function') return;
  const rank = (mime: string) =>
    mime === 'video/H264' ? 0 : mime === 'video/VP8' ? 1 : mime === 'video/VP9' ? 2 : 3;
  const codecs = [...capabilities.codecs].sort((a, b) => rank(a.mimeType) - rank(b.mimeType));
  try {
    transceiver.setCodecPreferences(codecs);
  } catch {
    // Not fatal: default negotiation still works.
  }
}

const RECONNECT_GRACE_MS = 2_000;
const RECONNECT_GIVE_UP_MS = 30_000;

export class ControllerSession {
  readonly sessionId: string;
  permissions: SessionPermission[] = [];
  private pc: RTCPeerConnection | null = null;
  private channels = new Map<string, RTCDataChannel>();
  private files: FileTransferChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private iceServers: RTCIceServer[] = [];
  private unsubscribe: (() => void) | null = null;
  private statsTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private giveUpTimer: number | null = null;
  private stats = new InboundStatsTracker();
  private everConnected = false;
  private closed = false;
  private clipboardWaiters = new Map<
    string,
    (result: { ok: boolean; text?: string; code?: string }) => void
  >();

  private constructor(
    private readonly api: DesktopApi,
    sessionId: string,
    private readonly callbacks: ControllerCallbacks,
  ) {
    this.sessionId = sessionId;
  }

  static async start(
    api: DesktopApi,
    input: StartSessionInput,
    callbacks: ControllerCallbacks,
  ): Promise<ControllerSession> {
    callbacks.onPhase('requesting');
    const result = await api.session.start(input);
    if (!result.ok) throw new Error(result.error.message);
    const session = new ControllerSession(api, result.value.sessionId, callbacks);
    session.unsubscribe = api.session.onEvent((event) => void session.onEvent(event));
    const snapshot = await api.session.ready(session.sessionId);
    if (snapshot.ok) session.iceServers = snapshot.value.iceServers;
    if (result.value.autoApproved) {
      session.permissions = result.value.permissions;
      callbacks.onPermissions(session.permissions);
      session.startPeer();
    } else {
      callbacks.onPhase(
        'awaiting-approval',
        result.value.targetOnline ? undefined : 'The device is offline. The request will expire.',
      );
    }
    return session;
  }

  private async onEvent(event: SessionEvent): Promise<void> {
    if (!('sessionId' in event) || event.sessionId !== this.sessionId || this.closed) return;
    switch (event.type) {
      case 'approved':
        this.permissions = event.permissions;
        this.callbacks.onPermissions(event.permissions);
        if (!this.pc) this.startPeer();
        return;
      case 'rejected':
        this.callbacks.onPhase('failed', 'The remote user declined the request.');
        this.close();
        return;
      case 'ice':
        this.iceServers = event.iceServers;
        this.pc?.setConfiguration({ ...this.pc.getConfiguration(), iceServers: event.iceServers });
        return;
      case 'signal':
        await this.onSignal(event.signal);
        return;
      case 'permissions':
        this.permissions = event.permissions;
        this.callbacks.onPermissions(event.permissions);
        return;
      case 'ended': {
        const reason = event.reason ?? 'ended';
        this.callbacks.onPhase(event.state === 'ENDED' ? 'ended' : 'failed', describeEnd(reason));
        this.close();
        return;
      }
      default:
        return;
    }
  }

  private startPeer(): void {
    this.callbacks.onPhase('connecting');
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    this.pc = pc;
    const transceiver = pc.addTransceiver('video', { direction: 'recvonly' });
    preferHardwareFriendlyCodecs(transceiver);
    for (const spec of Object.values(DATA_CHANNELS)) {
      const channel = pc.createDataChannel(spec.label, { ordered: spec.ordered });
      this.channels.set(spec.label, channel);
      channel.addEventListener('message', (event) => this.onChannelMessage(spec.label, event.data));
    }
    const fileChannel = this.channels.get('file');
    if (fileChannel) {
      this.files = new FileTransferChannel(
        fileChannel,
        this.api,
        this.sessionId,
        this.callbacks.onTransfer,
        () => this.permissions.includes('file_transfer'),
      );
    }
    pc.addEventListener('track', (event) => {
      const [stream] = event.streams;
      this.callbacks.onStream(stream ?? new MediaStream([event.track]));
    });
    pc.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return;
      void this.api.session.signal(this.sessionId, {
        kind: 'ice',
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        },
      });
    });
    // The controller is the only offerer: initial offer and ICE restarts.
    pc.addEventListener('negotiationneeded', () => void this.sendOffer());
    pc.addEventListener('connectionstatechange', () => this.onConnectionState());
    this.statsTimer = window.setInterval(() => void this.sampleStats(), 1_000);
  }

  private async sendOffer(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;
    await pc.setLocalDescription();
    const sdp = pc.localDescription?.sdp;
    if (!sdp) return;
    const result = await this.api.session.signal(this.sessionId, { kind: 'offer', sdp });
    if (!result.ok) {
      this.callbacks.onPhase('failed', result.error.message);
      await this.end('signaling_failed');
    }
  }

  private async onSignal(signal: SessionSignal): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    if (signal.kind === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      for (const candidate of this.pendingCandidates.splice(0)) await pc.addIceCandidate(candidate);
    } else if (signal.kind === 'ice') {
      const candidate: RTCIceCandidateInit = {
        candidate: signal.candidate.candidate,
        sdpMid: signal.candidate.sdpMid,
        sdpMLineIndex: signal.candidate.sdpMLineIndex,
      };
      if (pc.remoteDescription) await pc.addIceCandidate(candidate).catch(() => undefined);
      else this.pendingCandidates.push(candidate);
    }
  }

  private onConnectionState(): void {
    const pc = this.pc;
    if (!pc || this.closed) return;
    switch (pc.connectionState) {
      case 'connected':
        this.clearReconnectTimers();
        void this.api.session.report(this.sessionId, 'CONNECTED');
        this.everConnected = true;
        this.callbacks.onPhase('connected');
        return;
      case 'disconnected':
      case 'failed':
        if (!this.everConnected) {
          if (pc.connectionState === 'failed') {
            this.callbacks.onPhase(
              'failed',
              'Could not establish a connection (firewall or NAT). A TURN relay may be required.',
            );
            void this.end('connect_failed');
          }
          return;
        }
        if (this.reconnectTimer !== null) return;
        // Brief blips recover by themselves; otherwise restart ICE.
        this.reconnectTimer = window.setTimeout(() => {
          if (!this.pc || this.pc.connectionState === 'connected') return;
          this.callbacks.onPhase('reconnecting');
          void this.api.session.report(this.sessionId, 'RECONNECTING');
          this.pc.restartIce();
        }, RECONNECT_GRACE_MS);
        this.giveUpTimer = window.setTimeout(() => {
          if (this.pc?.connectionState === 'connected') return;
          this.callbacks.onPhase('failed', 'The connection was lost.');
          void this.end('connection_lost');
        }, RECONNECT_GIVE_UP_MS);
        return;
      default:
        return;
    }
  }

  private clearReconnectTimers(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    if (this.giveUpTimer !== null) window.clearTimeout(this.giveUpTimer);
    this.reconnectTimer = null;
    this.giveUpTimer = null;
  }

  private async sampleStats(): Promise<void> {
    if (!this.pc || this.closed) return;
    this.callbacks.onStats(await this.stats.sample(this.pc));
  }

  private onChannelMessage(label: string, data: unknown): void {
    if (label === 'control') {
      const parsed = parseChannelMessage('control', data);
      if (!parsed.ok) return;
      const message = parsed.message;
      if (message.t === 'monitors')
        this.callbacks.onMonitors(message.monitors, message.current, message.follow);
      else if (message.t === 'quality') this.callbacks.onQuality(message);
    } else if (label === 'clipboard') {
      const parsed = parseChannelMessage('clipboard', data);
      if (!parsed.ok) return;
      const message = parsed.message;
      const waiter = this.clipboardWaiters.get(message.id);
      if (!waiter) return;
      this.clipboardWaiters.delete(message.id);
      if (message.t === 'data') waiter({ ok: true, text: message.text });
      else if (message.t === 'ok') waiter({ ok: true });
      else if (message.t === 'error') waiter({ ok: false, code: message.code });
    }
  }

  // ------------------------------------------------------------------ actions

  private sendOn(label: string, message: unknown): boolean {
    const channel = this.channels.get(label);
    if (!channel || channel.readyState !== 'open') return false;
    channel.send(JSON.stringify(message));
    return true;
  }

  can(...needed: SessionPermission[]): boolean {
    return needed.every((p) => this.permissions.includes(p));
  }

  /** Sends input only if the session currently allows it (the host enforces this too). */
  sendInput(message: InputMessage): void {
    if (message.t === 'release') {
      this.sendOn('input', message);
      return;
    }
    const pointer =
      message.t === 'mm' ||
      message.t === 'md' ||
      message.t === 'mu' ||
      message.t === 'mc' ||
      message.t === 'ms';
    if (pointer ? !this.can('remote_control', 'mouse') : !this.can('remote_control', 'keyboard'))
      return;
    this.sendOn('input', message);
  }

  sendControl(message: ControlMessage): void {
    this.sendOn('control', message);
  }

  private clipboardRequest(message: { t: 'set'; text: string } | { t: 'get' }) {
    const id = crypto.randomUUID();
    return new Promise<{ ok: boolean; text?: string; code?: string }>((resolve) => {
      this.clipboardWaiters.set(id, resolve);
      if (!this.sendOn('clipboard', { ...message, id })) {
        this.clipboardWaiters.delete(id);
        resolve({ ok: false, code: 'not_connected' });
      }
      window.setTimeout(() => {
        if (this.clipboardWaiters.delete(id)) resolve({ ok: false, code: 'timeout' });
      }, 10_000);
    });
  }

  /** Explicit user action: copy this computer's clipboard text to the remote clipboard. */
  async sendClipboard(): Promise<string> {
    const local = await this.api.controller.readClipboard(this.sessionId);
    if (!local.ok) return local.error.message;
    const result = await this.clipboardRequest({ t: 'set', text: local.value });
    return result.ok
      ? 'Clipboard sent to the remote computer.'
      : `Clipboard not sent (${result.code}).`;
  }

  /** Explicit user action: fetch the remote clipboard text into this computer's clipboard. */
  async fetchClipboard(): Promise<string> {
    const result = await this.clipboardRequest({ t: 'get' });
    if (!result.ok || result.text === undefined)
      return `Could not read the remote clipboard (${result.code}).`;
    const written = await this.api.controller.writeClipboard(this.sessionId, result.text);
    return written.ok ? 'Remote clipboard copied to this computer.' : written.error.message;
  }

  async sendFile(file: File): Promise<void> {
    if (!this.can('file_transfer')) return;
    await this.files?.sendFile(file, file.name);
  }

  cancelTransfer(id: string): void {
    this.files?.cancel(id);
  }

  async end(reason = 'ended_by_controller'): Promise<void> {
    if (this.closed) return;
    this.sendOn('input', { t: 'release' });
    await this.api.session.end(this.sessionId, reason);
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearReconnectTimers();
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer);
    this.files?.dispose();
    for (const channel of this.channels.values()) channel.close();
    this.channels.clear();
    this.pc?.getReceivers().forEach((receiver) => receiver.track.stop());
    this.pc?.close();
    this.pc = null;
    this.unsubscribe?.();
  }
}

export function describeEnd(reason: string): string {
  switch (reason) {
    case 'ended_by_remote_user':
      return 'The remote user ended the session.';
    case 'ended_by_user':
    case 'ended_by_controller':
      return 'Session ended.';
    case 'peer_disconnected':
      return 'The other computer disconnected.';
    case 'authorization_expired':
      return 'The session was not connected in time and expired.';
    case 'access_revoked':
      return 'Your access to this device was revoked.';
    case 'expired':
      return 'The request expired before it was answered.';
    case 'device_revoked':
      return 'The device was removed.';
    default:
      return 'Session ended.';
  }
}
