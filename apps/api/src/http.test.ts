import { AppError } from '@remote-desktop/backend';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bearerToken, caller, parse, requestMeta } from './http';

const fakeRequest = (headers: Record<string, string>, ip = '203.0.113.1', auth = null) =>
  ({ headers, ip, auth }) as unknown as FastifyRequest;

describe('parse', () => {
  const schema = z.object({ name: z.string().min(1) }).strict();

  it('returns parsed data', () => {
    expect(parse(schema, { name: 'x' })).toEqual({ name: 'x' });
  });

  it('turns validation failures into 400 AppErrors with the field path', () => {
    try {
      parse(schema, { name: '' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(400);
      expect((error as AppError).message).toMatch(/^name: /);
    }
    expect(() => parse(schema, { name: 'x', extra: 1 })).toThrow(AppError);
    expect(() => parse(schema, undefined)).toThrow(AppError);
  });
});

describe('bearerToken', () => {
  it('extracts well-formed bearer tokens only', () => {
    expect(bearerToken(fakeRequest({ authorization: 'Bearer abc.def.ghijklmnopqrstu' }))).toBe(
      'abc.def.ghijklmnopqrstu',
    );
    expect(bearerToken(fakeRequest({}))).toBeNull();
    expect(bearerToken(fakeRequest({ authorization: 'Basic abcdefghijklmnopqrstu' }))).toBeNull();
    expect(bearerToken(fakeRequest({ authorization: 'Bearer short' }))).toBeNull();
    expect(bearerToken(fakeRequest({ authorization: 'Bearer has spaces in it ok' }))).toBeNull();
  });
});

describe('requestMeta / caller', () => {
  it('captures ip and a bounded user agent', () => {
    expect(requestMeta(fakeRequest({ 'user-agent': 'x'.repeat(500) }))).toEqual({
      ip: '203.0.113.1',
      userAgent: 'x'.repeat(200),
    });
  });

  it('refuses to run without authentication', () => {
    expect(() => caller(fakeRequest({}))).toThrow(AppError);
  });
});
