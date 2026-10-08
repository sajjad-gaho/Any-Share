import { describe, expect, it } from 'vitest';
import { MAX_SDP_LENGTH, deviceAuthMessage, parseClientMessage } from './signaling';

const SESSION = '6c1a7c1e-6e2f-4d6a-9a43-3c1d2f0b7a11';

function frame(value: unknown): string {
  return JSON.stringify(value);
}

describe('parseClientMessage', () => {
  it('accepts a well-formed offer', () => {
    const result = parseClientMessage(
      frame({ type: 'webrtc.offer', id: '1', payload: { sessionId: SESSION, sdp: 'v=0' } }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects non-JSON and unknown types', () => {
    expect(parseClientMessage('{nope').ok).toBe(false);
    expect(parseClientMessage(frame({ type: 'admin.shell', id: '1', payload: {} })).ok).toBe(false);
  });

  it('rejects identity fields smuggled into a message', () => {
    const smuggled = parseClientMessage(
      frame({
        type: 'webrtc.offer',
        id: '7',
        payload: { sessionId: SESSION, sdp: 'v=0', fromUserId: SESSION },
      }),
    );
    expect(smuggled).toMatchObject({ ok: false, id: '7' });
    const topLevel = parseClientMessage(
      frame({ type: 'session.end', id: '8', userId: SESSION, payload: { sessionId: SESSION } }),
    );
    expect(topLevel.ok).toBe(false);
  });

  it('rejects malformed ids and oversized payloads', () => {
    expect(
      parseClientMessage(frame({ type: 'session.end', id: '1', payload: { sessionId: '42' } })).ok,
    ).toBe(false);
    expect(
      parseClientMessage(
        frame({
          type: 'webrtc.offer',
          id: '1',
          payload: { sessionId: SESSION, sdp: 'x'.repeat(MAX_SDP_LENGTH + 1) },
        }),
      ).ok,
    ).toBe(false);
  });

  it('validates permission sets on requests', () => {
    const base = { type: 'connection.request', id: '1' };
    expect(
      parseClientMessage(
        frame({ ...base, payload: { targetDeviceCode: '123456782', permissions: ['mouse'] } }),
      ).ok,
    ).toBe(false);
    expect(
      parseClientMessage(
        frame({
          ...base,
          payload: { targetDeviceCode: '123456782', permissions: ['screen_view'] },
        }),
      ).ok,
    ).toBe(true);
  });
});

describe('deviceAuthMessage', () => {
  it('binds the nonce and the device', () => {
    expect(deviceAuthMessage('abc', SESSION)).toBe(`kestrel-signaling-auth:v1:abc:${SESSION}`);
  });
});
