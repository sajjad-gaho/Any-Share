// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrameDecoder, encodeCommand } from '../native/protocol';
import { matchDisplays, monitorAt } from './displays';
import { FileSink, sanitizeFileName } from './file-sink';
import { ALLOWED_KEY_CODES, authorizeInput, boundingArea } from './policy';

const AREA = { x: 1920, y: 0, width: 1280, height: 1024 };
const ALL = [
  'screen_view',
  'mouse',
  'keyboard',
  'clipboard',
  'file_transfer',
  'remote_control',
] as const;

describe('authorizeInput', () => {
  it('maps normalised pointer positions into the shared monitor only', () => {
    const decision = authorizeInput({ t: 'mm', x: 0, y: 0 }, [...ALL], AREA);
    expect(decision).toEqual({
      allowed: true,
      commands: [{ cmd: 'MOUSE_MOVE', args: { x: 1920, y: 0 } }],
    });
    const corner = authorizeInput({ t: 'mm', x: 1, y: 1 }, [...ALL], AREA);
    expect(corner).toEqual({
      allowed: true,
      commands: [{ cmd: 'MOUSE_MOVE', args: { x: 3199, y: 1023 } }],
    });
  });

  it('denies mouse without remote_control + mouse, and keys without keyboard', () => {
    expect(authorizeInput({ t: 'md', b: 'left' }, ['screen_view'], AREA)).toEqual({
      allowed: false,
      reason: 'mouse_not_permitted',
    });
    expect(authorizeInput({ t: 'md', b: 'left' }, ['screen_view', 'mouse'], AREA).allowed).toBe(
      false,
    );
    expect(
      authorizeInput({ t: 'kd', c: 'KeyA' }, ['screen_view', 'mouse', 'remote_control'], AREA),
    ).toEqual({
      allowed: false,
      reason: 'keyboard_not_permitted',
    });
  });

  it('refuses keys outside the allowlist and expands combos', () => {
    expect(authorizeInput({ t: 'kd', c: 'Power' }, [...ALL], AREA)).toEqual({
      allowed: false,
      reason: 'key_not_allowed',
    });
    const combo = authorizeInput({ t: 'combo', combo: 'alt_tab' }, [...ALL], AREA);
    expect(combo.allowed && combo.commands.map((c) => ('args' in c ? c.args : null))).toEqual([
      { code: 'AltLeft', action: 'down' },
      { code: 'Tab', action: 'down' },
      { code: 'Tab', action: 'up' },
      { code: 'AltLeft', action: 'up' },
    ]);
  });

  it('always allows releasing held input, even without permissions', () => {
    expect(authorizeInput({ t: 'release' }, [], null)).toEqual({
      allowed: true,
      commands: [{ cmd: 'RELEASE_ALL_INPUT' }],
    });
  });

  it('refuses pointer moves when nothing is being shared', () => {
    expect(authorizeInput({ t: 'mm', x: 0.5, y: 0.5 }, [...ALL], null)).toEqual({
      allowed: false,
      reason: 'no_capture_area',
    });
  });

  it('keeps the TS key allowlist aligned with common keys', () => {
    for (const code of ['KeyA', 'Digit0', 'F24', 'Enter', 'MetaLeft', 'NumpadEnter', 'ArrowLeft']) {
      expect(ALLOWED_KEY_CODES.has(code)).toBe(true);
    }
    expect(ALLOWED_KEY_CODES.has('Power')).toBe(false);
  });
});

describe('displays', () => {
  const monitor = (id: string, x: number, y: number, primary = false) => ({
    id,
    name: id,
    primary,
    x,
    y,
    width: 1920,
    height: 1080,
    scaleFactor: 1,
    refreshHz: 60,
  });

  it('matches monitors to Electron displays by physical origin', () => {
    const targets = matchDisplays(
      [monitor('A', 0, 0, true), monitor('B', -1920, 1)],
      [
        { id: '10', rect: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
        { id: '11', rect: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
      ],
    );
    expect(targets.map((t) => t.displayId)).toEqual(['10', '11']);
  });

  it('finds the monitor under a point and the bounding area of several', () => {
    const monitors = [monitor('A', 0, 0), monitor('B', 1920, 0)];
    expect(monitorAt(monitors, 2000, 10)?.id).toBe('B');
    expect(monitorAt(monitors, 5000, 10)).toBeNull();
    expect(boundingArea(monitors)).toEqual({ x: 0, y: 0, width: 3840, height: 1080 });
  });
});

describe('sanitizeFileName', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['../../Windows/System32/evil.dll', 'evil.dll'],
    ['..\\..\\boot.ini', 'boot.ini'],
    ['C:\\Users\\a\\file.txt', 'file.txt'],
    ['con.txt', '_con.txt'],
    ['NUL', '_NUL'],
    ['aux.tar.gz', '_aux.tar.gz'],
    ['file.txt:secret', 'file.txt_secret'],
    ['what?.txt', 'what_.txt'],
    ['  trailing dots...  ', 'trailing dots'],
    ['', 'file'],
    ['..', 'file'],
    ['\u0000\u0007.exe', '__.exe'],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });

  it('limits the length but keeps the extension', () => {
    const name = sanitizeFileName(`${'a'.repeat(300)}.txt`);
    expect(name.endsWith('.txt')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(160);
  });
});

describe('FileSink', () => {
  const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

  async function sink(maxBytes?: number) {
    const dir = await mkdtemp(join(tmpdir(), 'kestrel-sink-'));
    return { dir, sink: new FileSink(dir, maxBytes) };
  }

  it('writes, verifies and publishes a file under its own folder', async () => {
    const { dir, sink: files } = await sink();
    const data = Buffer.from('hello world');
    const { name } = await files.begin(
      '11111111-1111-4111-8111-111111111111',
      '../escape.txt',
      data.length,
    );
    expect(name).toBe('escape.txt');
    await files.write('11111111-1111-4111-8111-111111111111', data);
    const done = await files.finish('11111111-1111-4111-8111-111111111111', sha(data));
    expect(done.path).toBe(join(dir, 'escape.txt'));
    expect(await readFile(done.path, 'utf8')).toBe('hello world');
    expect(await readdir(dir)).toEqual(['escape.txt']);
  });

  it('never overwrites existing files', async () => {
    const { dir, sink: files } = await sink();
    await writeFile(join(dir, 'a.txt'), 'original');
    const { name } = await files.begin('22222222-2222-4222-8222-222222222222', 'a.txt', 1);
    expect(name).toBe('a (1).txt');
    await files.write('22222222-2222-4222-8222-222222222222', Buffer.from('x'));
    await files.finish('22222222-2222-4222-8222-222222222222', sha(Buffer.from('x')));
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('original');
  });

  it('rejects corrupted data and cleans up', async () => {
    const { dir, sink: files } = await sink();
    await files.begin('33333333-3333-4333-8333-333333333333', 'b.bin', 3);
    await files.write('33333333-3333-4333-8333-333333333333', Buffer.from('abc'));
    await expect(
      files.finish('33333333-3333-4333-8333-333333333333', sha(Buffer.from('abd'))),
    ).rejects.toMatchObject({
      code: 'integrity',
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it('enforces the announced and maximum sizes', async () => {
    const { dir, sink: files } = await sink(10);
    await expect(
      files.begin('44444444-4444-4444-8444-444444444444', 'big.bin', 11),
    ).rejects.toMatchObject({ code: 'too_large' });
    await files.begin('55555555-5555-4555-8555-555555555555', 'c.bin', 2);
    await expect(
      files.write('55555555-5555-4555-8555-555555555555', Buffer.from('abc')),
    ).rejects.toMatchObject({
      code: 'too_large',
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it('cancels cleanly and refuses unknown transfers', async () => {
    const { dir, sink: files } = await sink();
    await files.begin('66666666-6666-4666-8666-666666666666', 'd.txt', 5);
    expect(await files.cancel('66666666-6666-4666-8666-666666666666')).toBe(true);
    expect(await readdir(dir)).toEqual([]);
    await expect(
      files.write('66666666-6666-4666-8666-666666666666', Buffer.from('x')),
    ).rejects.toMatchObject({ code: 'unknown' });
  });
});

describe('helper protocol framing', () => {
  function frame(kind: number, body: Buffer): Buffer {
    const out = Buffer.alloc(5 + body.length);
    out.writeUInt32LE(body.length + 1, 0);
    out[4] = kind;
    body.copy(out, 5);
    return out;
  }

  it('encodes commands as length-prefixed JSON', () => {
    const encoded = encodeCommand(7, { cmd: 'MOUSE_MOVE', args: { x: 1, y: 2 } });
    expect(encoded.readUInt32LE(0)).toBe(encoded.length - 4);
    expect(encoded[4]).toBe(1);
    expect(JSON.parse(encoded.subarray(5).toString())).toEqual({
      id: 7,
      cmd: 'MOUSE_MOVE',
      args: { x: 1, y: 2 },
    });
  });

  it('decodes split responses and validates their shape', () => {
    const decoder = new FrameDecoder();
    const response = frame(1, Buffer.from(JSON.stringify({ id: 1, ok: true, result: { a: 1 } })));
    expect(decoder.push(response.subarray(0, 3))).toEqual([]);
    expect(decoder.push(response.subarray(3))).toEqual([
      { kind: 'message', message: { id: 1, ok: true, result: { a: 1 } } },
    ]);
    const bogus = frame(1, Buffer.from(JSON.stringify({ id: 1, ok: 'yes' })));
    expect(decoder.push(bogus)[0]?.kind).toBe('invalid');
  });

  it('checks video frame sizes', () => {
    const header = Buffer.from(
      JSON.stringify({
        seq: 1,
        monitorId: 'M',
        width: 2,
        height: 1,
        sourceWidth: 2,
        sourceHeight: 1,
        timestampUs: 0,
      }),
    );
    const lengthPrefix = Buffer.alloc(4);
    lengthPrefix.writeUInt32LE(header.length, 0);
    const good = frame(2, Buffer.concat([lengthPrefix, header, Buffer.alloc(8)]));
    const bad = frame(2, Buffer.concat([lengthPrefix, header, Buffer.alloc(7)]));
    const decoder = new FrameDecoder();
    expect(decoder.push(good)[0]?.kind).toBe('frame');
    expect(decoder.push(bad)[0]).toEqual({ kind: 'invalid', reason: 'frame size mismatch' });
  });

  it('treats an impossible frame length as fatal', () => {
    const decoder = new FrameDecoder();
    const huge = Buffer.alloc(8);
    huge.writeUInt32LE(0xffffffff, 0);
    expect(() => decoder.push(huge)).toThrow(/out of range/);
  });
});
