/**
 * Host side of a remote session. Runs in the always-visible
 * "REMOTE SESSION ACTIVE" window, never in a hidden context.
 *
 * Capture: Chromium's desktop capture (Windows Graphics Capture / DXGI under
 * the hood) feeds the WebRTC encoder directly, using hardware H.264 when the
 * GPU offers it. If that is unavailable, the native helper's DXGI capture is
 * used instead, delivered as frames into a MediaStreamTrackGenerator.
 *
 * Every peer message is validated here and then *forwarded* to the main
 * process, which checks the session's server-granted permissions before
 * touching input, clipboard or disk.
 */
import type { SessionPermission } from '@remote-desktop/shared';
import {
  INITIAL_QUALITY,
  QUALITY_LADDER,
  nextQuality,
  parseChannelMessage,
  type ControlMessage,
  type MonitorInfo,
  type MonitorSelection,
  type QualityPreset,
  type QualityState,
} from '@remote-desktop/webrtc';
import {
  NATIVE_FRAMES_MESSAGE,
  type DesktopApi,
  type SessionEvent,
  type SessionPeerInfo,
  type SessionSignal,
} from '../../../shared/ipc';
import { FileTransferChannel, type TransferProgress } from './file-transfer';
import { OutboundStatsTracker, type SessionStats } from './stats';

// Chromium "breakout box" API (not yet in the TypeScript DOM library).
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'video' });
  readonly writable: WritableStream<VideoFrame>;
}

export type HostPhase = 'waiting' | 'connecting' | 'connected' | 'reconnecting' | 'ended';

export interface HostCallbacks {
  onPhase(phase: HostPhase, detail?: string): void;
  onPermissions(permissions: SessionPermission[]): void;
  onActivity(text: string): void;
  onTransfer(progress: TransferProgress): void;
  onStats(stats: SessionStats & { level: number }): void;
  onMonitor(current: MonitorSelection, monitors: MonitorInfo[]): void;
}

interface Capture {
  track: MediaStreamTrack;
  stop(): void;
  native: boolean;
}

/** Stop the session if the peer keeps sending garbage. */
const MAX_MALFORMED = 50;
const COMPOSITE_MAX_WIDTH = 2560;
const COMPOSITE_FPS = 15;

export class HostSession {
  permissions: SessionPermission[] = [];
  peer: SessionPeerInfo | null = null;
  private pc: RTCPeerConnection | null = null;
  private capture: Capture | null = null;
  private files: FileTransferChannel | null = null;
  private channels = new Map<string, RTCDataChannel>();
  private iceServers: RTCIceServer[] = [];
  private pendingCandidates: RTCIceCandidateInit[] = [];
  /** Signals that arrive before the peer connection exists (queued by main until ready). */
  private earlySignals: SessionSignal[] = [];
  private monitors: MonitorInfo[] = [];
  private selection: MonitorSelection = 'all';
  private follow = false;
  private preset: QualityPreset = 'auto';
  private quality: QualityState = INITIAL_QUALITY;
  private stats = new OutboundStatsTracker();
  private statsTimer: number | null = null;
  private statsTicks = 0;
  private inputChain: Promise<unknown> = Promise.resolve();
  private malformed = 0;
  private closed = false;
  private unsubscribe: (() => void) | null = null;
  startedAt = new Date().toISOString();

  constructor(
    private readonly api: DesktopApi,
    readonly sessionId: string,
    private readonly callbacks: HostCallbacks,
  ) {}

  async start(): Promise<void> {
    this.unsubscribe = this.api.session.onEvent((event) => void this.onEvent(event));
    const snapshot = await this.api.session.ready(this.sessionId);
    if (!snapshot.ok) {
      this.callbacks.onPhase('ended', snapshot.error.message);
      return;
    }
    this.permissions = snapshot.value.permissions;
    this.peer = snapshot.value.peer;
    this.iceServers = snapshot.value.iceServers;
    this.startedAt = snapshot.value.startedAt;
    this.callbacks.onPermissions(this.permissions);
    const monitors = await this.api.host.monitors(this.sessionId);
    if (monitors.ok) {
      this.monitors = monitors.value.monitors;
      this.selection = monitors.value.current;
      this.callbacks.onMonitor(this.selection, this.monitors);
      if (!monitors.value.nativeHelper) {
        this.callbacks.onActivity(
          'Remote mouse, keyboard and clipboard are unavailable (native helper not running).',
        );
      }
    }
    this.createPeer();
    this.callbacks.onPhase('waiting');
    for (const signal of this.earlySignals.splice(0)) await this.onSignal(signal);
  }

  private createPeer(): void {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    this.pc = pc;
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
    pc.addEventListener('datachannel', (event) => this.attachChannel(event.channel));
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') this.callbacks.onPhase('connected');
      else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this.callbacks.onPhase('reconnecting');
      }
    });
    this.statsTimer = window.setInterval(() => void this.adaptQuality(), 1_000);
  }

  private async onEvent(event: SessionEvent): Promise<void> {
    if (!('sessionId' in event) || event.sessionId !== this.sessionId || this.closed) return;
    switch (event.type) {
      case 'signal':
        await this.onSignal(event.signal);
        return;
      case 'ice':
        this.iceServers = event.iceServers;
        this.pc?.setConfiguration({ ...this.pc.getConfiguration(), iceServers: event.iceServers });
        return;
      case 'permissions':
        this.permissions = event.permissions;
        this.callbacks.onPermissions(event.permissions);
        return;
      case 'follow':
        if (this.follow) await this.switchMonitor(event.monitorId);
        return;
      case 'activity':
        this.callbacks.onActivity(event.text);
        return;
      case 'ended':
        this.close();
        this.callbacks.onPhase('ended', event.reason ?? undefined);
        return;
      default:
        return;
    }
  }

  private async onSignal(signal: SessionSignal): Promise<void> {
    const pc = this.pc;
    if (!pc) {
      // main flushes queued events as soon as we are ready, which can be
      // before the monitors are loaded and the peer connection exists.
      this.earlySignals.push(signal);
      return;
    }
    if (signal.kind === 'offer') {
      this.callbacks.onPhase('connecting');
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      const transceiver = pc.getTransceivers().find((t) => t.receiver.track.kind === 'video');
      if (transceiver && !this.capture) {
        try {
          this.capture = await this.captureSelection(this.selection);
        } catch (error) {
          this.callbacks.onActivity(`Screen capture failed: ${(error as Error).message}`);
          await this.end('capture_failed');
          return;
        }
        await transceiver.sender.replaceTrack(this.capture.track);
        transceiver.direction = 'sendonly';
        this.applyQuality();
      }
      await pc.setLocalDescription();
      for (const candidate of this.pendingCandidates.splice(0)) await pc.addIceCandidate(candidate);
      const sdp = pc.localDescription?.sdp;
      if (sdp) await this.api.session.signal(this.sessionId, { kind: 'answer', sdp });
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

  // ---------------------------------------------------------------- capture

  private async captureSelection(selection: MonitorSelection): Promise<Capture> {
    const prepared = await this.api.host.selectMonitor(this.sessionId, selection);
    if (!prepared.ok) throw new Error(prepared.error.message);
    try {
      if (prepared.value.captures === 1) {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30, max: 30 } },
          audio: false,
        });
        const [track] = stream.getVideoTracks();
        if (!track) throw new Error('No video track');
        track.contentHint = 'detail';
        return { track, stop: () => track.stop(), native: false };
      }
      return await this.compositeAll(prepared.value.captures);
    } catch (error) {
      if (selection === 'all') throw error;
      this.callbacks.onActivity('Using the native screen capture fallback.');
      return this.nativeCapture(selection);
    }
  }

  /** "All monitors": draw each monitor into one canvas at its physical position. */
  private async compositeAll(count: number): Promise<Capture> {
    const tracks: MediaStreamTrack[] = [];
    for (let i = 0; i < count; i++) {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { max: COMPOSITE_FPS } },
        audio: false,
      });
      const [track] = stream.getVideoTracks();
      if (track) tracks.push(track);
    }
    const monitors = this.monitors.slice(0, tracks.length);
    const left = Math.min(...monitors.map((m) => m.x));
    const top = Math.min(...monitors.map((m) => m.y));
    const width = Math.max(...monitors.map((m) => m.x + m.width)) - left;
    const height = Math.max(...monitors.map((m) => m.y + m.height)) - top;
    const scale = Math.min(1, COMPOSITE_MAX_WIDTH / width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext('2d');
    const videos = tracks.map((track) => {
      const video = document.createElement('video');
      video.muted = true;
      video.srcObject = new MediaStream([track]);
      void video.play();
      return video;
    });
    const timer = window.setInterval(() => {
      if (!context) return;
      monitors.forEach((m, i) => {
        const video = videos[i];
        if (video && video.readyState >= 2) {
          context.drawImage(
            video,
            (m.x - left) * scale,
            (m.y - top) * scale,
            m.width * scale,
            m.height * scale,
          );
        }
      });
    }, 1000 / COMPOSITE_FPS);
    const [output] = canvas.captureStream(COMPOSITE_FPS).getVideoTracks();
    if (!output) throw new Error('Composite capture failed');
    return {
      track: output,
      native: false,
      stop: () => {
        window.clearInterval(timer);
        output.stop();
        tracks.forEach((t) => t.stop());
      },
    };
  }

  /** Fallback: frames from the Rust helper (DXGI Desktop Duplication). */
  private async nativeCapture(monitorId: string): Promise<Capture> {
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    const writer = generator.writable.getWriter();
    let port: MessagePort | null = null;
    const onWindowMessage = (event: MessageEvent) => {
      if (
        (event.data as { type?: unknown } | null)?.type !== NATIVE_FRAMES_MESSAGE ||
        !event.ports[0]
      )
        return;
      port = event.ports[0];
      port.onmessage = (
        message: MessageEvent<{
          header: { width: number; height: number; timestampUs: number };
          pixels: Uint8Array;
        }>,
      ) => {
        const { header, pixels } = message.data;
        const frame = new VideoFrame(pixels, {
          format: 'BGRA',
          codedWidth: header.width,
          codedHeight: header.height,
          timestamp: header.timestampUs,
        });
        void writer.write(frame).catch(() => frame.close());
      };
      port.start();
    };
    window.addEventListener('message', onWindowMessage);
    const level = QUALITY_LADDER[this.quality.level] ?? QUALITY_LADDER[1];
    const started = await this.api.host.startNativeCapture(this.sessionId, {
      monitorId,
      maxFps: Math.min(level?.maxFramerate ?? 20, 20),
      maxWidth: 1920,
    });
    if (!started.ok) {
      window.removeEventListener('message', onWindowMessage);
      throw new Error(started.error.message);
    }
    return {
      track: generator,
      native: true,
      stop: () => {
        window.removeEventListener('message', onWindowMessage);
        (port as MessagePort | null)?.close();
        void this.api.host.stopNativeCapture(this.sessionId);
        void writer.close().catch(() => undefined);
        generator.stop();
      },
    };
  }

  private async switchMonitor(selection: MonitorSelection): Promise<void> {
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === 'video' || s.track === null);
    if (!sender || selection === this.selection) return;
    const next = await this.captureSelection(selection);
    await sender.replaceTrack(next.track);
    this.capture?.stop();
    this.capture = next;
    this.selection = selection;
    this.applyQuality();
    this.callbacks.onMonitor(selection, this.monitors);
    this.sendMonitors();
  }

  // ---------------------------------------------------------------- quality

  private applyQuality(): void {
    const sender = this.pc?.getSenders().find((s) => s.track !== null);
    const level = QUALITY_LADDER[this.quality.level];
    if (!sender || !level) return;
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) parameters.encodings = [{}];
    const [encoding] = parameters.encodings;
    if (!encoding) return;
    encoding.maxBitrate = level.maxBitrate;
    encoding.maxFramerate = level.maxFramerate;
    encoding.scaleResolutionDownBy = level.scale;
    parameters.degradationPreference = 'balanced';
    void sender.setParameters(parameters).catch(() => undefined);
  }

  private async adaptQuality(): Promise<void> {
    if (!this.pc || this.closed || this.pc.connectionState !== 'connected') return;
    const stats = await this.stats.sample(this.pc);
    const next = nextQuality(this.quality, stats, this.preset);
    const changed = next.level !== this.quality.level;
    this.quality = next;
    if (changed) this.applyQuality();
    this.callbacks.onStats({ ...stats, level: next.level });
    this.statsTicks += 1;
    // Tell the controller on every change, and every 5 s otherwise.
    if (changed || this.statsTicks % 5 === 0) {
      this.sendControl({
        t: 'quality',
        preset: this.preset,
        level: next.level,
        width: stats.width ?? 0,
        height: stats.height ?? 0,
        fps: stats.fps ?? 0,
      });
    }
  }

  // --------------------------------------------------------------- channels

  private attachChannel(channel: RTCDataChannel): void {
    if (
      !['control', 'input', 'clipboard', 'file'].includes(channel.label) ||
      this.channels.has(channel.label)
    ) {
      channel.close();
      return;
    }
    this.channels.set(channel.label, channel);
    if (channel.label === 'file') {
      this.files = new FileTransferChannel(
        channel,
        this.api,
        this.sessionId,
        this.callbacks.onTransfer,
        () => this.permissions.includes('file_transfer'),
      );
      return;
    }
    channel.addEventListener('open', () => {
      if (channel.label === 'control') this.sendMonitors();
    });
    channel.addEventListener(
      'message',
      (event) => void this.onChannelMessage(channel.label, event.data),
    );
  }

  private malformedMessage(): void {
    this.malformed += 1;
    if (this.malformed === MAX_MALFORMED) {
      this.callbacks.onActivity(
        'The remote side sent too many invalid messages; ending the session.',
      );
      void this.end('protocol_violation');
    }
  }

  private async onChannelMessage(label: string, data: unknown): Promise<void> {
    if (label === 'input') {
      const parsed = parseChannelMessage('input', data);
      if (!parsed.ok) return this.malformedMessage();
      const message = parsed.message;
      // Serialised so ordering is preserved; main authorizes each one.
      this.inputChain = this.inputChain
        .then(() => this.api.host.input(this.sessionId, message))
        .catch(() => undefined);
      return;
    }
    if (label === 'clipboard') {
      const parsed = parseChannelMessage('clipboard', data);
      if (!parsed.ok) return this.malformedMessage();
      const message = parsed.message;
      if (message.t === 'set') {
        const result = await this.api.host.writeClipboard(this.sessionId, message.text);
        this.sendOn(
          'clipboard',
          result.ok
            ? { t: 'ok', id: message.id }
            : { t: 'error', id: message.id, code: result.error.code },
        );
      } else if (message.t === 'get') {
        const result = await this.api.host.readClipboard(this.sessionId);
        this.sendOn(
          'clipboard',
          result.ok
            ? { t: 'data', id: message.id, text: result.value }
            : { t: 'error', id: message.id, code: result.error.code },
        );
      }
      return;
    }
    if (label === 'control') {
      const parsed = parseChannelMessage('control', data);
      if (!parsed.ok) return this.malformedMessage();
      const message = parsed.message;
      switch (message.t) {
        case 'monitor.select':
          await this.switchMonitor(message.monitor).catch((error: Error) =>
            this.callbacks.onActivity(`Could not switch monitor: ${error.message}`),
          );
          return;
        case 'monitor.follow':
          this.follow = message.enabled;
          await this.api.host.setFollow(this.sessionId, message.enabled);
          this.sendMonitors();
          return;
        case 'quality.preset':
          this.preset = message.preset;
          this.quality = nextQuality(
            { ...this.quality, cooldown: 0 },
            { rttMs: null, lossRate: null },
            this.preset,
          );
          this.applyQuality();
          return;
        case 'ping':
          this.sendControl({ t: 'pong', n: message.n });
          return;
        default:
          return; // host->controller messages are ignored if echoed back
      }
    }
  }

  private sendOn(label: string, message: unknown): void {
    const channel = this.channels.get(label);
    if (channel?.readyState === 'open') channel.send(JSON.stringify(message));
  }

  private sendControl(message: ControlMessage): void {
    this.sendOn('control', message);
  }

  private sendMonitors(): void {
    this.sendControl({
      t: 'monitors',
      monitors: this.monitors,
      current: this.selection,
      follow: this.follow,
    });
  }

  // ---------------------------------------------------------------- actions

  async setPermissions(permissions: SessionPermission[]): Promise<string | null> {
    const result = await this.api.session.setPermissions(this.sessionId, permissions);
    if (!result.ok) return result.error.message;
    this.permissions = result.value;
    this.callbacks.onPermissions(result.value);
    return null;
  }

  async sendFile(file: File): Promise<void> {
    await this.files?.sendFile(file, file.name);
  }

  cancelTransfer(id: string): void {
    this.files?.cancel(id);
  }

  async end(reason = 'ended_by_remote_user'): Promise<void> {
    if (this.closed) return;
    // Stop sharing immediately; telling the server can take a moment.
    this.close();
    this.callbacks.onPhase('ended', reason);
    await this.api.session.end(this.sessionId, reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer);
    this.files?.dispose();
    this.capture?.stop();
    this.capture = null;
    for (const channel of this.channels.values()) channel.close();
    this.channels.clear();
    this.pc?.close();
    this.pc = null;
    this.unsubscribe?.();
  }
}
