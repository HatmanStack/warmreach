import { describe, it, expect } from 'vitest';
import { unwrapEnvelope } from './apiEnvelope';

describe('unwrapEnvelope', () => {
  it('returns the value unchanged when it is not a Lambda-proxy envelope', () => {
    const data = { tier: 'pro', features: {} };
    expect(unwrapEnvelope(data)).toBe(data);
  });

  it('unwraps a { statusCode, body } envelope with an object body', () => {
    const wrapped = { statusCode: 200, body: { tier: 'pro' } };
    expect(unwrapEnvelope<{ tier: string }>(wrapped)).toEqual({ tier: 'pro' });
  });

  it('parses a JSON-string body', () => {
    const wrapped = { statusCode: 200, body: JSON.stringify({ url: 'https://checkout' }) };
    expect(unwrapEnvelope<{ url: string }>(wrapped)).toEqual({ url: 'https://checkout' });
  });

  it('passes through null/undefined safely', () => {
    expect(unwrapEnvelope(null)).toBeNull();
    expect(unwrapEnvelope(undefined)).toBeUndefined();
  });

  it('throws on an error envelope instead of decoding it as success', () => {
    const wrapped = { statusCode: 500, body: JSON.stringify({ error: 'boom' }) };
    expect(() => unwrapEnvelope(wrapped)).toThrow('boom');
  });

  it('throws with a status message when an error envelope has no error field', () => {
    expect(() => unwrapEnvelope({ statusCode: 403, body: {} })).toThrow(/status 403/);
  });
});
