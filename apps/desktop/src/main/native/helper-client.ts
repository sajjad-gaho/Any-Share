import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import {
  FrameDecoder,
  HELPER_PROTOCOL_VERSION,
  encodeCommand,
  nativeMonitorSchema,
  type FrameHeader,
  type HelperCommand,
  type NativeMonitor,
} from './protocol';

export class HelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HelperError';
  }
}

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface HelperEvents {
  frame: [header: FrameHeader, pixels: Buffer];
  captureStopped: [info: { monitorId: string; reason: string; code?: string }];
  exit: [code: number | null];
}

/**
 * Owns one helper process. The helper is spawned without a shell, with a
 * fixed path and no arguments, and talks only over its stdio — so no other
 * process can send it commands. It is started for host sessions and shut
 * down when the last one ends (no background persistence).
 */
export class HelperClient extends EventEmitter<HelperEvents> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private exited = false;

  private constructor(private readonly executable: string) {
    super();
  }

  static async start(executable: string): Promise<HelperClient> {
    if (!existsSync(executable)) {
      throw new HelperError('helper_missing', 'The native helper is not installed');
    }
    const client = new HelperClient(executable);
    client.spawn();
    await client.request({ cmd: 'HELLO', args: { protocol: HELPER_PROTOCOL_VERSION } });
    return client;
  }

  private spawn(): void {
    const child = spawn(this.executable, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr.on('data', (chunk: Buffer) =>
      console.error('[helper]', chunk.toString('utf8').slice(0, 500)),
    );
    child.on('exit', (code) => this.onExit(code));
    child.on('error', (error) => {
      console.error('Native helper failed', error.message);
      this.onExit(null);
    });
  }

  private onData(chunk: Buffer): void {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      // A corrupt stream cannot be resynchronised safely: kill the helper.
      console.error('Native helper protocol violation', (error as Error).message);
      this.kill();
      return;
    }
    for (const frame of frames) {
      if (frame.kind === 'frame') {
        this.emit('frame', frame.header, frame.pixels);
      } else if (frame.kind === 'invalid') {
        console.error('Ignoring invalid helper message:', frame.reason);
      } else if ('event' in frame.message) {
        this.emit('captureStopped', frame.message);
      } else {
        const { id } = frame.message;
        const pending = id === null ? undefined : this.pending.get(id);
        if (!pending || id === null) continue;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (frame.message.ok) pending.resolve(frame.message.result);
        else pending.reject(new HelperError(frame.message.error.code, frame.message.error.message));
      }
    }
  }

  private onExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HelperError('helper_exited', 'The native helper stopped'));
    }
    this.pending.clear();
    this.emit('exit', code);
  }

  get alive(): boolean {
    return !this.exited;
  }

  request(command: HelperCommand, timeoutMs = 5_000): Promise<Record<string, unknown>> {
    if (this.exited || !this.child) {
      return Promise.reject(new HelperError('helper_exited', 'The native helper is not running'));
    }
    const id = this.nextId++;
    const frame = encodeCommand(id, command);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperError('timeout', `Native helper did not answer ${command.cmd}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(frame);
    });
  }

  async monitors(): Promise<NativeMonitor[]> {
    const result = await this.request({ cmd: 'GET_MONITORS' });
    return nativeMonitorSchema.array().max(16).parse(result['monitors']);
  }

  async clipboardText(): Promise<string> {
    const result = await this.request({ cmd: 'GET_CLIPBOARD' });
    const text = result['text'];
    return typeof text === 'string' ? text : '';
  }

  /** Graceful stop: release input, then SHUTDOWN, then kill if it lingers. */
  async shutdown(): Promise<void> {
    if (this.exited) return;
    await this.request({ cmd: 'RELEASE_ALL_INPUT' }, 1_000).catch(() => undefined);
    await this.request({ cmd: 'SHUTDOWN' }, 1_000).catch(() => undefined);
    this.child?.stdin.end();
    setTimeout(() => this.kill(), 1_500).unref();
  }

  kill(): void {
    if (!this.exited) this.child?.kill();
  }
}
