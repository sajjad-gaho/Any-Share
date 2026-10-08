/**
 * Receiving side of a file transfer, in the main process.
 *
 * The peer (and the renderer relaying for it) only supplies a *name* and
 * bytes. The destination directory is fixed by this module, the name is
 * reduced to a safe basename, nothing is ever overwritten, sizes are
 * enforced, and the file only appears under its final name after the
 * SHA-256 of everything received matches the sender's.
 */
import { createHash, type Hash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { MAX_FILE_BYTES, MAX_FILE_NAME_LENGTH } from '@remote-desktop/webrtc';

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)$/i;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
const MAX_STEM = 150;

/**
 * Reduces any peer-supplied name to a single safe Windows file name: no
 * directories, no traversal, no device names, no alternate data streams,
 * no trailing dots or spaces.
 */
export function sanitizeFileName(raw: string): string {
  const normalized = raw.normalize('NFC');
  const base = normalized.split(/[/\\]/).pop() ?? '';
  let name = base
    .replace(FORBIDDEN_CHARS, '_')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '');
  if (!name || name === '_') name = 'file';
  const ext = extname(name).slice(0, 16);
  let stem = ext ? name.slice(0, -extname(name).length) : name;
  if (RESERVED.test(stem) || RESERVED.test(stem.split('.')[0] ?? '')) stem = `_${stem}`;
  if (!stem) stem = 'file';
  stem = stem.slice(0, MAX_STEM);
  return `${stem}${ext}`;
}

interface ActiveTransfer {
  id: string;
  expectedSize: number;
  received: number;
  hash: Hash;
  handle: FileHandle;
  partialPath: string;
  finalPath: string;
}

export class FileTransferError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FileTransferError';
  }
}

export interface ReceivedFile {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
}

export class FileSink {
  private readonly transfers = new Map<string, ActiveTransfer>();

  constructor(
    private readonly directory: string,
    private readonly maxBytes = MAX_FILE_BYTES,
    private readonly maxConcurrent = 4,
  ) {}

  /** Reserves a unique final name (exclusive create) and opens a partial file. */
  async begin(id: string, rawName: string, size: number): Promise<{ name: string }> {
    if (this.transfers.has(id))
      throw new FileTransferError('duplicate', 'Transfer already in progress');
    if (this.transfers.size >= this.maxConcurrent) {
      throw new FileTransferError('busy', 'Too many transfers at once');
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > this.maxBytes) {
      throw new FileTransferError('too_large', 'File is larger than allowed');
    }
    if (rawName.length > MAX_FILE_NAME_LENGTH) {
      throw new FileTransferError('bad_name', 'File name is too long');
    }
    await mkdir(this.directory, { recursive: true });
    const safe = sanitizeFileName(rawName);
    const ext = extname(safe);
    const stem = ext ? safe.slice(0, -ext.length) : safe;

    for (let attempt = 0; attempt < 1000; attempt++) {
      const name = attempt === 0 ? safe : `${stem} (${attempt})${ext}`;
      const finalPath = join(this.directory, name);
      try {
        // 'wx' = O_CREAT|O_EXCL: fails if anything already has this name.
        const reserved = await open(
          finalPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        );
        await reserved.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw new FileTransferError('io_error', 'Cannot create the file');
      }
      const partialPath = `${finalPath}.partial`;
      let handle: FileHandle;
      try {
        handle = await open(partialPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      } catch {
        await rm(finalPath, { force: true });
        continue;
      }
      this.transfers.set(id, {
        id,
        expectedSize: size,
        received: 0,
        hash: createHash('sha256'),
        handle,
        partialPath,
        finalPath,
      });
      return { name };
    }
    throw new FileTransferError('io_error', 'No free file name');
  }

  async write(id: string, chunk: Uint8Array): Promise<{ received: number }> {
    const transfer = this.transfers.get(id);
    if (!transfer) throw new FileTransferError('unknown', 'No such transfer');
    if (transfer.received + chunk.byteLength > transfer.expectedSize) {
      await this.cancel(id);
      throw new FileTransferError('too_large', 'More data than announced');
    }
    await transfer.handle.write(chunk);
    transfer.hash.update(chunk);
    transfer.received += chunk.byteLength;
    return { received: transfer.received };
  }

  /** Verifies size and hash, then moves the data under its reserved final name. */
  async finish(id: string, expectedSha256: string): Promise<ReceivedFile> {
    const transfer = this.transfers.get(id);
    if (!transfer) throw new FileTransferError('unknown', 'No such transfer');
    this.transfers.delete(id);
    await transfer.handle.close();
    const sha256 = transfer.hash.digest('hex');
    if (transfer.received !== transfer.expectedSize || sha256 !== expectedSha256) {
      await this.discard(transfer);
      throw new FileTransferError('integrity', 'File failed the integrity check');
    }
    // Replaces only the empty placeholder this sink created in begin().
    await rename(transfer.partialPath, transfer.finalPath);
    return {
      name: transfer.finalPath.slice(this.directory.length + 1),
      path: transfer.finalPath,
      bytes: transfer.received,
      sha256,
    };
  }

  async cancel(id: string): Promise<boolean> {
    const transfer = this.transfers.get(id);
    if (!transfer) return false;
    this.transfers.delete(id);
    await transfer.handle.close().catch(() => undefined);
    await this.discard(transfer);
    return true;
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.transfers.keys()].map((id) => this.cancel(id)));
  }

  private async discard(transfer: ActiveTransfer): Promise<void> {
    await rm(transfer.partialPath, { force: true });
    await rm(transfer.finalPath, { force: true });
  }
}
