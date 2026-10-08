/**
 * WebRTC DataChannel protocol between controller and host.
 *
 * Every message is validated on receipt with strict schemas and size limits.
 * These messages only *request* actions: the host's Electron main process
 * re-checks the session's granted permissions (received from the server,
 * never from the peer) before anything reaches the native helper or disk.
 */
import { z } from 'zod';

export const DATA_CHANNELS = {
  /** Monitor selection, quality, pings. Reliable, ordered. */
  control: { label: 'control', ordered: true },
  /** Mouse and keyboard. Reliable and ordered so key-up never gets lost. */
  input: { label: 'input', ordered: true },
  /** Explicit, user-initiated clipboard transfers. */
  clipboard: { label: 'clipboard', ordered: true },
  /** File transfer control messages and binary chunks. */
  file: { label: 'file', ordered: true },
} as const;
export type DataChannelName = keyof typeof DATA_CHANNELS;

export const MAX_CONTROL_MESSAGE_BYTES = 16 * 1024;
export const MAX_CLIPBOARD_TEXT_BYTES = 256 * 1024;
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const FILE_CHUNK_BYTES = 16 * 1024;
export const MAX_FILE_NAME_LENGTH = 200;

const unit = z.number().min(0).max(1);
const monitorId = z.string().min(1).max(64);
const transferId = z.uuid();

export const QUALITY_PRESETS = ['auto', 'quality', 'balanced', 'speed'] as const;
export const qualityPresetSchema = z.enum(QUALITY_PRESETS);
export type QualityPreset = z.infer<typeof qualityPresetSchema>;

export const monitorInfoSchema = z
  .object({
    id: monitorId,
    name: z.string().max(64),
    primary: z.boolean(),
    /** Physical position on the virtual desktop (used to lay out "all monitors"). */
    x: z.number().int().min(-65536).max(65536),
    y: z.number().int().min(-65536).max(65536),
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
    scaleFactor: z.number().positive().max(8),
  })
  .strict();
export type MonitorInfo = z.infer<typeof monitorInfoSchema>;

/** `"all"` streams every monitor side by side. */
export const monitorSelectionSchema = z.union([monitorId, z.literal('all')]);
export type MonitorSelection = z.infer<typeof monitorSelectionSchema>;

// ---------------------------------------------------------------------------
// control
// ---------------------------------------------------------------------------

export const controlMessageSchema = z.discriminatedUnion('t', [
  // host -> controller
  z
    .object({
      t: z.literal('monitors'),
      monitors: z.array(monitorInfoSchema).max(16),
      current: monitorSelectionSchema,
      follow: z.boolean(),
    })
    .strict(),
  z
    .object({
      t: z.literal('quality'),
      preset: qualityPresetSchema,
      level: z.number().int().min(0).max(10),
      width: z.number().int().nonnegative(),
      height: z.number().int().nonnegative(),
      fps: z.number().nonnegative(),
    })
    .strict(),
  z.object({ t: z.literal('pong'), n: z.number().int().nonnegative() }).strict(),
  // controller -> host
  z.object({ t: z.literal('monitor.select'), monitor: monitorSelectionSchema }).strict(),
  z.object({ t: z.literal('monitor.follow'), enabled: z.boolean() }).strict(),
  z.object({ t: z.literal('quality.preset'), preset: qualityPresetSchema }).strict(),
  z.object({ t: z.literal('ping'), n: z.number().int().nonnegative() }).strict(),
]);
export type ControlMessage = z.infer<typeof controlMessageSchema>;

// ---------------------------------------------------------------------------
// input (controller -> host only)
// ---------------------------------------------------------------------------

export const mouseButtonSchema = z.enum(['left', 'right', 'middle']);
export type MouseButtonName = z.infer<typeof mouseButtonSchema>;

/**
 * Key codes are DOM `KeyboardEvent.code` values; the host and the native
 * helper both enforce an allowlist.
 */
const keyCode = z.string().regex(/^[A-Za-z0-9]{1,24}$/);

/** Shortcuts the controller's own OS would intercept, sent as a sequence. */
export const SPECIAL_KEY_COMBOS = [
  'win',
  'alt_tab',
  'ctrl_shift_esc',
  'ctrl_esc',
  'print_screen',
] as const;
export const specialComboSchema = z.enum(SPECIAL_KEY_COMBOS);
export type SpecialCombo = z.infer<typeof specialComboSchema>;

export const inputMessageSchema = z.discriminatedUnion('t', [
  /** Pointer position, normalised to the streamed area (0..1). */
  z.object({ t: z.literal('mm'), x: unit, y: unit }).strict(),
  z.object({ t: z.literal('md'), b: mouseButtonSchema }).strict(),
  z.object({ t: z.literal('mu'), b: mouseButtonSchema }).strict(),
  /** Click (n=1) or double click (n=2) at the current position. */
  z
    .object({ t: z.literal('mc'), b: mouseButtonSchema, n: z.union([z.literal(1), z.literal(2)]) })
    .strict(),
  /** Wheel delta in Windows units (120 per notch). */
  z
    .object({
      t: z.literal('ms'),
      dx: z.number().int().min(-2400).max(2400),
      dy: z.number().int().min(-2400).max(2400),
    })
    .strict(),
  z.object({ t: z.literal('kd'), c: keyCode }).strict(),
  z.object({ t: z.literal('ku'), c: keyCode }).strict(),
  z.object({ t: z.literal('combo'), combo: specialComboSchema }).strict(),
  /** Release every key/button the host injected (focus lost, mode switch). */
  z.object({ t: z.literal('release') }).strict(),
]);
export type InputMessage = z.infer<typeof inputMessageSchema>;

// ---------------------------------------------------------------------------
// clipboard
// ---------------------------------------------------------------------------

const requestId = z.string().min(1).max(36);
export const clipboardMessageSchema = z.discriminatedUnion('t', [
  /** controller -> host: put this text on the remote clipboard. */
  z.object({ t: z.literal('set'), id: requestId, text: z.string() }).strict(),
  /** controller -> host: send me the remote clipboard text. */
  z.object({ t: z.literal('get'), id: requestId }).strict(),
  /** host -> controller */
  z.object({ t: z.literal('data'), id: requestId, text: z.string() }).strict(),
  z.object({ t: z.literal('ok'), id: requestId }).strict(),
  z.object({ t: z.literal('error'), id: requestId, code: z.string().max(40) }).strict(),
]);
export type ClipboardMessage = z.infer<typeof clipboardMessageSchema>;

// ---------------------------------------------------------------------------
// file (both directions)
// ---------------------------------------------------------------------------

export const fileMessageSchema = z.discriminatedUnion('t', [
  z
    .object({
      t: z.literal('offer'),
      id: transferId,
      name: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
      size: z.number().int().min(0).max(MAX_FILE_BYTES),
    })
    .strict(),
  z.object({ t: z.literal('accept'), id: transferId }).strict(),
  z.object({ t: z.literal('reject'), id: transferId, reason: z.string().max(40) }).strict(),
  /** Sender: all chunks sent; this is the SHA-256 of the whole file (hex). */
  z
    .object({
      t: z.literal('complete'),
      id: transferId,
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  /** Receiver: final verdict after verifying size and hash. */
  z
    .object({
      t: z.literal('result'),
      id: transferId,
      ok: z.boolean(),
      reason: z.string().max(40).optional(),
    })
    .strict(),
  z
    .object({ t: z.literal('cancel'), id: transferId, reason: z.string().max(40).optional() })
    .strict(),
]);
export type FileMessage = z.infer<typeof fileMessageSchema>;

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

const SCHEMAS = {
  control: controlMessageSchema,
  input: inputMessageSchema,
  clipboard: clipboardMessageSchema,
  file: fileMessageSchema,
} as const;

type MessageOf<C extends DataChannelName> = z.infer<(typeof SCHEMAS)[C]>;

export type ParseResult<T> = { ok: true; message: T } | { ok: false; error: string };

function maxBytesFor(channel: DataChannelName): number {
  return channel === 'clipboard' ? MAX_CLIPBOARD_TEXT_BYTES + 1024 : MAX_CONTROL_MESSAGE_BYTES;
}

/** Validates one text message received on `channel`. Never throws. */
export function parseChannelMessage<C extends DataChannelName>(
  channel: C,
  raw: unknown,
): ParseResult<MessageOf<C>> {
  if (typeof raw !== 'string') return { ok: false, error: 'Expected a text message' };
  if (raw.length > maxBytesFor(channel)) return { ok: false, error: 'Message too large' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }
  const result = SCHEMAS[channel].safeParse(json);
  if (!result.success)
    return { ok: false, error: result.error.issues[0]?.message ?? 'Invalid message' };
  if (channel === 'clipboard') {
    const message = result.data as ClipboardMessage;
    if (
      'text' in message &&
      new TextEncoder().encode(message.text).length > MAX_CLIPBOARD_TEXT_BYTES
    ) {
      return { ok: false, error: 'Clipboard text too large' };
    }
  }
  return { ok: true, message: result.data as MessageOf<C> };
}

// ---------------------------------------------------------------------------
// binary file chunks: [version u8 = 1][transfer id: 16 bytes][payload]
// ---------------------------------------------------------------------------

const CHUNK_VERSION = 1;
const CHUNK_HEADER_BYTES = 17;

function uuidToBytes(id: string): Uint8Array {
  const hex = id.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function encodeFileChunk(id: string, payload: Uint8Array): Uint8Array {
  if (payload.byteLength > FILE_CHUNK_BYTES) throw new RangeError('Chunk too large');
  const out = new Uint8Array(CHUNK_HEADER_BYTES + payload.byteLength);
  out[0] = CHUNK_VERSION;
  out.set(uuidToBytes(id), 1);
  out.set(payload, CHUNK_HEADER_BYTES);
  return out;
}

export function decodeFileChunk(
  data: ArrayBuffer | Uint8Array,
): { ok: true; id: string; payload: Uint8Array } | { ok: false; error: string } {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < CHUNK_HEADER_BYTES) return { ok: false, error: 'Chunk too short' };
  if (bytes.byteLength > CHUNK_HEADER_BYTES + FILE_CHUNK_BYTES)
    return { ok: false, error: 'Chunk too large' };
  if (bytes[0] !== CHUNK_VERSION) return { ok: false, error: 'Unknown chunk version' };
  const id = bytesToUuid(bytes.subarray(1, CHUNK_HEADER_BYTES));
  if (!transferId.safeParse(id).success) return { ok: false, error: 'Invalid transfer id' };
  return { ok: true, id, payload: bytes.subarray(CHUNK_HEADER_BYTES) };
}
