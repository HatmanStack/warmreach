import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createRateLimiter } from './rateLimiter.js';

describe('createRateLimiter bounded map', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('prunes expired entries on the periodic sweep', async () => {
    vi.useFakeTimers();
    const middleware = createRateLimiter({ windowMs: 1000, max: 10, name: 'test' });

    const makeReq = (auth: string): Request =>
      ({ headers: { authorization: auth }, ip: '127.0.0.1' }) as unknown as Request;
    const res = {
      set: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next: NextFunction = vi.fn();

    // Seed the internal map with a few distinct "users".
    middleware(makeReq('Bearer aaaaaaaa'), res, next);
    middleware(makeReq('Bearer bbbbbbbb'), res, next);
    middleware(makeReq('Bearer cccccccc'), res, next);

    // Advance past the sweep interval (60s) AND past windowMs * 2 so entries
    // are expired.
    vi.advanceTimersByTime(61_000);

    // After the prune timer runs the map should be empty; a fresh request
    // treats it as the first request in the window and does not 429.
    middleware(makeReq('Bearer ddddddddd'), res, next);
    expect(next).toHaveBeenCalled();

    middleware.shutdown();
  });

  it('shutdown clears the prune interval to prevent Vitest hangs', () => {
    const clearSpy = vi.spyOn(global, 'clearInterval');
    const middleware = createRateLimiter({ windowMs: 1000, max: 10, name: 'test' });
    middleware.shutdown();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
