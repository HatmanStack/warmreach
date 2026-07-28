import { describe, it, expect, afterEach } from 'vitest';
import { envInt, envFloat } from '#config';

const KEY = 'WARMREACH_ENV_HELPER_TEST';

afterEach(() => {
  delete process.env[KEY];
});

describe('envInt', () => {
  // The 60 call sites this replaced were all `parseInt(process.env.X) || d`,
  // so the fallback cases have to match that expression exactly — including
  // the surprising one, where an explicit 0 falls back rather than sticking.
  it.each([
    ['unset', undefined, 7],
    ['empty', '', 7],
    ['whitespace', '   ', 7],
    ['unparseable', 'banana', 7],
    ['explicit zero', '0', 7],
    ['plain integer', '42', 42],
    ['trailing junk', '42abc', 42],
    ['negative', '-3', -3],
  ])('%s -> %s', (_label, value, expected) => {
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    expect(envInt(KEY, 7)).toBe(expected);
  });

  it('reads a hex-looking value in base 10, not base 16', () => {
    process.env[KEY] = '0x10';
    expect(envInt(KEY, 7)).toBe(7);
  });
});

describe('envFloat', () => {
  it('parses a decimal', () => {
    process.env[KEY] = '0.25';
    expect(envFloat(KEY, 0.1)).toBe(0.25);
  });

  it('falls back when unset or unparseable', () => {
    expect(envFloat(KEY, 0.1)).toBe(0.1);
    process.env[KEY] = 'banana';
    expect(envFloat(KEY, 0.1)).toBe(0.1);
  });
});
