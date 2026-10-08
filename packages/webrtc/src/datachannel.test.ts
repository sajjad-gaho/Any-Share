import { describe, expect, it } from 'vitest';
import {
  FILE_CHUNK_BYTES,
  MAX_CLIPBOARD_TEXT_BYTES,
  decodeFileChunk,
  encodeFileChunk,
  parseChannelMessage,
} from './datachannel';
import { INITIAL_QUALITY, lossBetween, nextQuality, type QualityState } from './quality';
import { parseClientMessage } from './signaling';

const ID = '6c1a7c1e-6e2f-4d6a-9a43-3c1d2f0b7a11';
const j = (value: unknown) => JSON.stringify(value);

describe('input channel', () => {
  it('accepts well-formed input', () => {
    expect(parseChannelMessage('input', j({ t: 'mm', x: 0.5, y: 1 })).ok).toBe(true);
    expect(parseChannelMessage('input', j({ t: 'mc', b: 'left', n: 2 })).ok).toBe(true);
    expect(parseChannelMessage('input', j({ t: 'kd', c: 'KeyA' })).ok).toBe(true);
    expect(parseChannelMessage('input', j({ t: 'combo', combo: 'alt_tab' })).ok).toBe(true);
  });

  it.each([
    ['out-of-range pointer', { t: 'mm', x: 1.5, y: 0 }],
    ['triple click', { t: 'mc', b: 'left', n: 3 }],
    ['unknown button', { t: 'md', b: 'x1' }],
    ['huge scroll', { t: 'ms', dx: 0, dy: 1e9 }],
    ['key code injection', { t: 'kd', c: 'KeyA;calc.exe' }],
    ['unknown type', { t: 'exec', cmd: 'calc' }],
    ['smuggled permissions', { t: 'kd', c: 'KeyA', permissions: ['remote_control'] }],
    ['unknown combo', { t: 'combo', combo: 'ctrl_alt_del' }],
  ])('rejects %s', (_label, message) => {
    expect(parseChannelMessage('input', j(message)).ok).toBe(false);
  });

  it('rejects non-text, non-JSON and oversized frames', () => {
    expect(parseChannelMessage('input', new ArrayBuffer(4)).ok).toBe(false);
    expect(parseChannelMessage('input', '{nope').ok).toBe(false);
    expect(parseChannelMessage('input', 'x'.repeat(20_000)).ok).toBe(false);
  });
});

describe('control channel', () => {
  it('validates monitor selection and presets', () => {
    expect(parseChannelMessage('control', j({ t: 'monitor.select', monitor: 'all' })).ok).toBe(
      true,
    );
    expect(parseChannelMessage('control', j({ t: 'monitor.select', monitor: '' })).ok).toBe(false);
    expect(parseChannelMessage('control', j({ t: 'quality.preset', preset: 'ultra' })).ok).toBe(
      false,
    );
  });
});

describe('clipboard channel', () => {
  it('enforces the text size limit in bytes', () => {
    expect(parseChannelMessage('clipboard', j({ t: 'set', id: '1', text: 'hello' })).ok).toBe(true);
    const tooBig = 'é'.repeat(MAX_CLIPBOARD_TEXT_BYTES / 2 + 1); // 2 bytes each in UTF-8
    expect(parseChannelMessage('clipboard', j({ t: 'set', id: '1', text: tooBig })).ok).toBe(false);
  });
});

describe('file channel', () => {
  it('validates offers', () => {
    expect(parseChannelMessage('file', j({ t: 'offer', id: ID, name: 'a.txt', size: 10 })).ok).toBe(
      true,
    );
    expect(
      parseChannelMessage('file', j({ t: 'offer', id: 'x', name: 'a.txt', size: 10 })).ok,
    ).toBe(false);
    expect(
      parseChannelMessage('file', j({ t: 'offer', id: ID, name: 'a.txt', size: 2 ** 40 })).ok,
    ).toBe(false);
    expect(parseChannelMessage('file', j({ t: 'complete', id: ID, sha256: 'not-a-hash' })).ok).toBe(
      false,
    );
  });

  it('round-trips binary chunks and rejects malformed ones', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const decoded = decodeFileChunk(encodeFileChunk(ID, payload));
    expect(decoded).toEqual({ ok: true, id: ID, payload });
    expect(decodeFileChunk(new Uint8Array(5)).ok).toBe(false);
    const wrongVersion = encodeFileChunk(ID, payload);
    wrongVersion[0] = 9;
    expect(decodeFileChunk(wrongVersion).ok).toBe(false);
    expect(() => encodeFileChunk(ID, new Uint8Array(FILE_CHUNK_BYTES + 1))).toThrow();
    expect(decodeFileChunk(new Uint8Array(17 + FILE_CHUNK_BYTES + 1)).ok).toBe(false);
  });
});

describe('signaling additions', () => {
  it('accepts verify/report/audit and rejects smuggled fields', () => {
    expect(
      parseClientMessage(j({ type: 'session.verify', id: '1', payload: { sessionId: ID } })).ok,
    ).toBe(true);
    expect(
      parseClientMessage(
        j({ type: 'session.report', id: '1', payload: { sessionId: ID, state: 'CONNECTED' } }),
      ).ok,
    ).toBe(true);
    expect(
      parseClientMessage(
        j({ type: 'session.report', id: '1', payload: { sessionId: ID, state: 'ENDED' } }),
      ).ok,
    ).toBe(false);
    expect(
      parseClientMessage(
        j({
          type: 'session.audit',
          id: '1',
          payload: {
            sessionId: ID,
            event: 'FILE_TRANSFER_COMPLETED',
            direction: 'controller_to_host',
            bytes: 5,
            fileName: 'secret.docx',
          },
        }),
      ).ok,
    ).toBe(false);
  });
});

describe('adaptive quality', () => {
  const run = (
    samples: { rttMs: number | null; lossRate: number | null }[],
    preset: 'auto' | 'speed' = 'auto',
  ) => samples.reduce<QualityState>((state, s) => nextQuality(state, s, preset), INITIAL_QUALITY);

  it('degrades on loss or latency and then waits', () => {
    const degraded = nextQuality(INITIAL_QUALITY, { rttMs: 50, lossRate: 0.2 }, 'auto');
    expect(degraded.level).toBe(INITIAL_QUALITY.level + 1);
    expect(degraded.cooldown).toBeGreaterThan(0);
    const stillCooling = nextQuality(degraded, { rttMs: 900, lossRate: 0.5 }, 'auto');
    expect(stillCooling.level).toBe(degraded.level);
  });

  it('upgrades only after sustained good conditions', () => {
    const good = Array.from({ length: 7 }, () => ({ rttMs: 20, lossRate: 0 }));
    expect(run(good).level).toBe(INITIAL_QUALITY.level);
    expect(run([...good, { rttMs: 20, lossRate: 0 }]).level).toBe(INITIAL_QUALITY.level - 1);
    expect(run([...good, { rttMs: 200, lossRate: 0 }]).level).toBe(INITIAL_QUALITY.level);
  });

  it('respects the preset range', () => {
    expect(nextQuality(INITIAL_QUALITY, { rttMs: 10, lossRate: 0 }, 'speed').level).toBe(3);
    const worst = Array.from({ length: 40 }, () => ({ rttMs: 999, lossRate: 0.5 }));
    expect(run(worst).level).toBe(4);
  });

  it('computes interval loss from cumulative counters', () => {
    expect(lossBetween(null, { packetsLost: 1, packetsReceived: 9 })).toBeNull();
    expect(
      lossBetween({ packetsLost: 0, packetsReceived: 0 }, { packetsLost: 5, packetsReceived: 95 }),
    ).toBe(0.05);
    expect(
      lossBetween({ packetsLost: 5, packetsReceived: 95 }, { packetsLost: 5, packetsReceived: 95 }),
    ).toBeNull();
  });
});
