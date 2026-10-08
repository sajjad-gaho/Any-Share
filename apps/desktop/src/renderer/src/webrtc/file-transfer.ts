/**
 * File transfer over the "file" DataChannel.
 *
 * Sender (renderer): offers the file, waits for acceptance, streams 16 KiB
 * binary chunks with backpressure (bufferedAmount), hashes as it goes and
 * finishes with the SHA-256. Receiver: the renderer only relays — main
 * decides the folder and name, enforces size limits and verifies the hash.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  FILE_CHUNK_BYTES,
  MAX_FILE_BYTES,
  decodeFileChunk,
  encodeFileChunk,
  parseChannelMessage,
  type FileMessage,
} from '@remote-desktop/webrtc';
import type { DesktopApi } from '../../../shared/ipc';

export type TransferDirection = 'send' | 'receive';
export type TransferStatus =
  'waiting' | 'transferring' | 'verifying' | 'done' | 'failed' | 'cancelled';

export interface TransferProgress {
  id: string;
  name: string;
  direction: TransferDirection;
  size: number;
  transferred: number;
  status: TransferStatus;
  message?: string;
}

const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;

interface Outgoing {
  file: Blob;
  name: string;
  cancelled: boolean;
  accepted: (ok: boolean, reason?: string) => void;
}

interface Incoming {
  name: string;
  size: number;
  received: number;
  /** Chunks are relayed to main strictly in order. */
  chain: Promise<void>;
  failed: boolean;
}

export class FileTransferChannel {
  private readonly outgoing = new Map<string, Outgoing>();
  private readonly incoming = new Map<string, Incoming>();

  constructor(
    private readonly channel: RTCDataChannel,
    private readonly api: DesktopApi,
    private readonly sessionId: string,
    private readonly onProgress: (progress: TransferProgress) => void,
    /** Whether the receiving side currently has the file_transfer permission (UX check; main enforces). */
    private readonly mayReceive: () => boolean,
  ) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER;
    channel.addEventListener('message', (event) => void this.onMessage(event.data));
  }

  private send(message: FileMessage): void {
    if (this.channel.readyState === 'open') this.channel.send(JSON.stringify(message));
  }

  // ---------------------------------------------------------------- sending

  async sendFile(file: Blob, name: string): Promise<void> {
    const id = crypto.randomUUID();
    const progress: TransferProgress = {
      id,
      name,
      direction: 'send',
      size: file.size,
      transferred: 0,
      status: 'waiting',
    };
    if (file.size > MAX_FILE_BYTES) {
      this.onProgress({ ...progress, status: 'failed', message: 'File is larger than 512 MB' });
      return;
    }
    this.onProgress(progress);
    const accepted = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      this.outgoing.set(id, {
        file,
        name,
        cancelled: false,
        accepted: (ok, reason) => resolve({ ok, reason }),
      });
      this.send({ t: 'offer', id, name: name.slice(0, 200), size: file.size });
    });
    const entry = this.outgoing.get(id);
    if (!accepted.ok || !entry || entry.cancelled) {
      this.outgoing.delete(id);
      this.onProgress({ ...progress, status: 'failed', message: accepted.reason ?? 'Rejected' });
      return;
    }
    const hash = sha256.create();
    let offset = 0;
    this.onProgress({ ...progress, status: 'transferring' });
    while (offset < file.size) {
      if (entry.cancelled || this.channel.readyState !== 'open') {
        this.outgoing.delete(id);
        this.onProgress({ ...progress, transferred: offset, status: 'cancelled' });
        return;
      }
      if (this.channel.bufferedAmount > HIGH_WATER) {
        await new Promise<void>((resolve) =>
          this.channel.addEventListener('bufferedamountlow', () => resolve(), { once: true }),
        );
        continue;
      }
      const chunk = new Uint8Array(
        await file.slice(offset, offset + FILE_CHUNK_BYTES).arrayBuffer(),
      );
      hash.update(chunk);
      this.channel.send(encodeFileChunk(id, chunk) as Uint8Array<ArrayBuffer>);
      offset += chunk.byteLength;
      this.onProgress({ ...progress, transferred: offset, status: 'transferring' });
    }
    this.send({ t: 'complete', id, sha256: bytesToHex(hash.digest()) });
    this.onProgress({ ...progress, transferred: offset, status: 'verifying' });
  }

  cancel(id: string): void {
    const outgoing = this.outgoing.get(id);
    if (outgoing) {
      outgoing.cancelled = true;
      outgoing.accepted(false, 'Cancelled');
    }
    if (this.incoming.has(id)) void this.abortIncoming(id, 'cancelled');
    this.send({ t: 'cancel', id, reason: 'cancelled' });
  }

  // -------------------------------------------------------------- receiving

  private async onMessage(data: unknown): Promise<void> {
    if (data instanceof ArrayBuffer) {
      this.onChunk(data);
      return;
    }
    const parsed = parseChannelMessage('file', data);
    if (!parsed.ok) return; // malformed: dropped
    const message = parsed.message;
    switch (message.t) {
      case 'offer':
        await this.onOffer(message.id, message.name, message.size);
        return;
      case 'accept':
        this.outgoing.get(message.id)?.accepted(true);
        return;
      case 'reject':
        this.outgoing.get(message.id)?.accepted(false, message.reason);
        return;
      case 'complete':
        await this.onComplete(message.id, message.sha256);
        return;
      case 'result': {
        const outgoing = this.outgoing.get(message.id);
        if (!outgoing) return;
        this.outgoing.delete(message.id);
        this.onProgress({
          id: message.id,
          name: outgoing.name,
          direction: 'send',
          size: outgoing.file.size,
          transferred: outgoing.file.size,
          status: message.ok ? 'done' : 'failed',
          message: message.reason,
        });
        return;
      }
      case 'cancel': {
        const outgoing = this.outgoing.get(message.id);
        if (outgoing) {
          outgoing.cancelled = true;
          outgoing.accepted(false, 'Cancelled by the other side');
        }
        if (this.incoming.has(message.id)) await this.abortIncoming(message.id, 'cancelled');
        return;
      }
    }
  }

  private async onOffer(id: string, name: string, size: number): Promise<void> {
    if (!this.mayReceive()) {
      this.send({ t: 'reject', id, reason: 'not_permitted' });
      return;
    }
    const result = await this.api.files.begin(this.sessionId, { id, name, size });
    if (!result.ok) {
      this.send({ t: 'reject', id, reason: result.error.code.slice(0, 40) });
      return;
    }
    this.incoming.set(id, {
      name: result.value.name,
      size,
      received: 0,
      chain: Promise.resolve(),
      failed: false,
    });
    this.onProgress({
      id,
      name: result.value.name,
      direction: 'receive',
      size,
      transferred: 0,
      status: 'transferring',
    });
    this.send({ t: 'accept', id });
  }

  private onChunk(data: ArrayBuffer): void {
    const decoded = decodeFileChunk(data);
    if (!decoded.ok) return;
    const incoming = this.incoming.get(decoded.id);
    if (!incoming || incoming.failed) return;
    const payload = decoded.payload.slice();
    incoming.chain = incoming.chain.then(async () => {
      if (incoming.failed) return;
      const result = await this.api.files.chunk(this.sessionId, decoded.id, payload);
      if (!result.ok) {
        await this.abortIncoming(decoded.id, result.error.code);
        return;
      }
      incoming.received += payload.byteLength;
      this.onProgress({
        id: decoded.id,
        name: incoming.name,
        direction: 'receive',
        size: incoming.size,
        transferred: incoming.received,
        status: 'transferring',
      });
    });
  }

  private async onComplete(id: string, hash: string): Promise<void> {
    const incoming = this.incoming.get(id);
    if (!incoming) return;
    await incoming.chain;
    if (incoming.failed) return;
    this.incoming.delete(id);
    this.onProgress({
      id,
      name: incoming.name,
      direction: 'receive',
      size: incoming.size,
      transferred: incoming.received,
      status: 'verifying',
    });
    const result = await this.api.files.finish(this.sessionId, id, hash);
    this.send({
      t: 'result',
      id,
      ok: result.ok,
      reason: result.ok ? undefined : result.error.code.slice(0, 40),
    });
    this.onProgress({
      id,
      name: result.ok ? result.value.name : incoming.name,
      direction: 'receive',
      size: incoming.size,
      transferred: incoming.received,
      status: result.ok ? 'done' : 'failed',
      message: result.ok ? undefined : result.error.message,
    });
  }

  private async abortIncoming(id: string, reason: string): Promise<void> {
    const incoming = this.incoming.get(id);
    if (!incoming) return;
    incoming.failed = true;
    this.incoming.delete(id);
    await this.api.files.cancel(this.sessionId, id);
    this.send({ t: 'cancel', id, reason: reason.slice(0, 40) });
    this.onProgress({
      id,
      name: incoming.name,
      direction: 'receive',
      size: incoming.size,
      transferred: incoming.received,
      status: reason === 'cancelled' ? 'cancelled' : 'failed',
      message: reason,
    });
  }

  dispose(): void {
    for (const [id, outgoing] of this.outgoing) {
      outgoing.cancelled = true;
      outgoing.accepted(false, 'Session ended');
      this.outgoing.delete(id);
    }
    for (const id of [...this.incoming.keys()]) void this.abortIncoming(id, 'session_ended');
  }
}
