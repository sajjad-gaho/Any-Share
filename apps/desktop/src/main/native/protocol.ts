/**
 * TypeScript side of the native helper protocol (native/windows-helper/src/protocol.rs).
 *
 * Frames: u32 LE body length, then body; body[0] = 0x01 JSON | 0x02 video frame.
 * Only the commands below can be sent, and every response is validated:
 * the main process does not trust the helper's output blindly either.
 */
import { z } from 'zod';

export const HELPER_PROTOCOL_VERSION = 1;
const KIND_JSON = 0x01;
const KIND_FRAME = 0x02;
/** A 4K BGRA frame plus header; anything larger is a protocol violation. */
export const MAX_HELPER_FRAME_BYTES = 3840 * 2160 * 4 + 64 * 1024;

export type MouseButton = 'left' | 'right' | 'middle';

export type HelperCommand =
  | { cmd: 'HELLO'; args: { protocol: number } }
  | { cmd: 'GET_MONITORS' }
  | { cmd: 'START_CAPTURE'; args: { monitorId: string; maxFps: number; maxWidth: number } }
  | { cmd: 'STOP_CAPTURE' }
  | { cmd: 'MOUSE_MOVE'; args: { x: number; y: number } }
  | { cmd: 'MOUSE_BUTTON'; args: { button: MouseButton; action: 'down' | 'up' } }
  | { cmd: 'MOUSE_CLICK'; args: { button: MouseButton; count: 1 | 2 } }
  | { cmd: 'MOUSE_SCROLL'; args: { deltaX: number; deltaY: number } }
  | { cmd: 'KEYBOARD_EVENT'; args: { code: string; action: 'down' | 'up' } }
  | { cmd: 'RELEASE_ALL_INPUT' }
  | { cmd: 'GET_CLIPBOARD' }
  | { cmd: 'SET_CLIPBOARD'; args: { text: string } }
  | { cmd: 'SHUTDOWN' };

export const nativeMonitorSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(64),
  primary: z.boolean(),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scaleFactor: z.number().positive(),
  refreshHz: z.number().int().nonnegative(),
});
export type NativeMonitor = z.infer<typeof nativeMonitorSchema>;

export const helperMessageSchema = z.union([
  z.object({
    id: z.number().int().nonnegative(),
    ok: z.literal(true),
    result: z.record(z.string(), z.unknown()),
  }),
  z.object({
    id: z.number().int().nonnegative().nullable(),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
  z.object({
    event: z.literal('captureStopped'),
    monitorId: z.string(),
    reason: z.enum(['stopped', 'error']),
    code: z.string().optional(),
    message: z.string().optional(),
  }),
]);
export type HelperMessage = z.infer<typeof helperMessageSchema>;

export const frameHeaderSchema = z.object({
  seq: z.number().int().nonnegative(),
  monitorId: z.string(),
  width: z.number().int().positive().max(7680),
  height: z.number().int().positive().max(4320),
  sourceWidth: z.number().int().positive(),
  sourceHeight: z.number().int().positive(),
  timestampUs: z.number().nonnegative(),
});
export type FrameHeader = z.infer<typeof frameHeaderSchema>;

export function encodeCommand(id: number, command: HelperCommand): Buffer {
  const body = Buffer.from(JSON.stringify({ id, ...command }), 'utf8');
  const frame = Buffer.alloc(4 + 1 + body.length);
  frame.writeUInt32LE(body.length + 1, 0);
  frame[4] = KIND_JSON;
  body.copy(frame, 5);
  return frame;
}

export type DecodedFrame =
  | { kind: 'message'; message: HelperMessage }
  | { kind: 'frame'; header: FrameHeader; pixels: Buffer }
  | { kind: 'invalid'; reason: string };

/**
 * Incremental decoder for the helper's stdout. Feed it chunks; it yields
 * complete frames. A length outside the allowed range is fatal (the stream
 * can no longer be trusted), signalled by throwing.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): DecodedFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: DecodedFrame[] = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_HELPER_FRAME_BYTES) {
        throw new Error('Helper frame length out of range');
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      out.push(decodeBody(Buffer.from(body)));
    }
    return out;
  }
}

function decodeBody(body: Buffer): DecodedFrame {
  if (body[0] === KIND_JSON) {
    let json: unknown;
    try {
      json = JSON.parse(body.subarray(1).toString('utf8'));
    } catch {
      return { kind: 'invalid', reason: 'invalid JSON' };
    }
    const parsed = helperMessageSchema.safeParse(json);
    return parsed.success
      ? { kind: 'message', message: parsed.data }
      : { kind: 'invalid', reason: 'unexpected message shape' };
  }
  if (body[0] === KIND_FRAME && body.length >= 5) {
    const headerLength = body.readUInt32LE(1);
    if (5 + headerLength > body.length) return { kind: 'invalid', reason: 'bad frame header' };
    let header: unknown;
    try {
      header = JSON.parse(body.subarray(5, 5 + headerLength).toString('utf8'));
    } catch {
      return { kind: 'invalid', reason: 'bad frame header' };
    }
    const parsed = frameHeaderSchema.safeParse(header);
    if (!parsed.success) return { kind: 'invalid', reason: 'bad frame header' };
    const pixels = body.subarray(5 + headerLength);
    if (pixels.length !== parsed.data.width * parsed.data.height * 4) {
      return { kind: 'invalid', reason: 'frame size mismatch' };
    }
    return { kind: 'frame', header: parsed.data, pixels };
  }
  return { kind: 'invalid', reason: 'unknown frame kind' };
}
