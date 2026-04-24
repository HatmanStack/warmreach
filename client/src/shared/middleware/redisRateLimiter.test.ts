import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock logger so we can assert on warn-level telemetry.
const loggerMock = { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() };
vi.mock('#utils/logger.js', () => ({
  logger: loggerMock,
}));

// Mock ioredis to force the Redis path to throw so fallback kicks in.
vi.mock('ioredis', () => {
  const failingMulti = {
    incr: vi.fn().mockReturnThis(),
    ttl: vi.fn().mockReturnThis(),
    exec: vi.fn().mockRejectedValue(new Error('redis exploded')),
  };
  class FakeRedis {
    multi() {
      return failingMulti;
    }
    on() {
      return this;
    }
    async quit() {
      /* no-op */
    }
  }
  return { default: { default: FakeRedis } };
});

describe('redisRateLimiter', () => {
  beforeEach(() => {
    vi.resetModules();
    loggerMock.warn.mockClear();
  });

  it('increments the fallback counter and logs WARN when Redis fails', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const mod = await import('./redisRateLimiter.js');
    mod.resetRedisFallbackCount();

    const middleware = mod.createRedisRateLimiter({ name: 'test' });

    const req = {
      headers: { authorization: 'Bearer abcdefghij' },
      ip: '127.0.0.1',
    } as unknown as Request;
    const res = {
      set: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(mod.getRedisFallbackCount()).toBeGreaterThanOrEqual(1);
    const warnCalls = loggerMock.warn.mock.calls;
    const fallbackWarn = warnCalls.find((c) =>
      String(c[0]).includes('Redis rate limit check failed')
    );
    expect(fallbackWarn).toBeTruthy();
    expect(fallbackWarn![1]).toMatchObject({ fallbackCount: expect.any(Number) });
  });
});
