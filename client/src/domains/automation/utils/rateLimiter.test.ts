import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateLimiter, RateLimitExceededError } from './rateLimiter.js';
import type { RateLimiterRedisClient } from './rateLimiter.js';

// All tests below run without REDIS_URL configured, so getRedisClient() returns
// null and the limiter uses its in-memory path — preserving the original
// behavior (now via the async API). The "durable" describe block injects a
// fake Redis client to exercise the persistence path.

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    delete process.env.REDIS_URL;
    limiter = new RateLimiter();
    vi.restoreAllMocks();
  });

  describe('enforce (in-memory)', () => {
    it('passes when under all thresholds', async () => {
      await expect(limiter.enforce()).resolves.toBeUndefined();
    });

    it('records an action on successful enforce', async () => {
      await limiter.enforce();
      await limiter.enforce();
      // Should still pass - well under 15/min
      await expect(limiter.enforce()).resolves.toBeUndefined();
    });

    it('throws RateLimitExceededError when minute threshold exceeded (15 actions in <60s)', async () => {
      for (let i = 0; i < 15; i++) {
        await limiter.enforce();
      }
      await expect(limiter.enforce()).rejects.toThrow(RateLimitExceededError);
      await expect(limiter.enforce()).rejects.toThrow('Rate limit exceeded');
    });

    it('throws when hour threshold exceeded (200 actions)', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now');

      for (let i = 0; i < 200; i++) {
        const minuteOffset = Math.floor(i / 14) * 61000; // new minute every 14 actions
        (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(now + minuteOffset);
        await limiter.enforce();
      }

      const lastOffset = Math.floor(200 / 14) * 61000;
      (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(now + lastOffset);
      await expect(limiter.enforce()).rejects.toThrow(RateLimitExceededError);
    });

    it('throws when day threshold exceeded (500 actions)', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now');

      for (let i = 0; i < 500; i++) {
        const hourOffset = Math.floor(i / 199) * 3601000;
        const minuteOffset = Math.floor((i % 199) / 14) * 61000;
        (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(now + hourOffset + minuteOffset);
        await limiter.enforce();
      }

      const finalOffset = Math.floor(500 / 199) * 3601000;
      (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(now + finalOffset);
      await expect(limiter.enforce()).rejects.toThrow(RateLimitExceededError);
    });

    it('prunes actions older than 24 hours', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now');

      (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(now - 25 * 3600000);
      for (let i = 0; i < 10; i++) {
        await limiter.enforce();
      }

      (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(now);
      await expect(limiter.enforce()).resolves.toBeUndefined();
    });
  });

  describe('recordAction (in-memory)', () => {
    it('records an action timestamp', async () => {
      await limiter.recordAction();
      await limiter.recordAction();
      await expect(limiter.enforce()).resolves.toBeUndefined();
    });

    it('prunes entries older than 24 hours', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now');

      (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(now - 25 * 3600000);
      for (let i = 0; i < 10; i++) {
        await limiter.recordAction();
      }

      (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(now);
      await limiter.recordAction();

      await expect(limiter.enforce()).resolves.toBeUndefined();
    });
  });

  describe('reset (in-memory)', () => {
    it('clears the action log', async () => {
      for (let i = 0; i < 15; i++) {
        await limiter.enforce();
      }
      await expect(limiter.enforce()).rejects.toThrow(RateLimitExceededError);

      await limiter.reset();
      await expect(limiter.enforce()).resolves.toBeUndefined();
    });
  });

  describe('custom thresholds', () => {
    it('accepts custom threshold overrides', async () => {
      const strict = new RateLimiter({ perMinute: 2, perHour: 10, perDay: 50 });
      await strict.enforce();
      await strict.enforce();
      await expect(strict.enforce()).rejects.toThrow(RateLimitExceededError);
    });
  });

  describe('RateLimitExceededError', () => {
    it('has correct name and code', () => {
      const error = new RateLimitExceededError('test');
      expect(error.name).toBe('RateLimitExceededError');
      expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(error.message).toBe('test');
      expect(error).toBeInstanceOf(Error);
    });
  });
});

/**
 * A tiny in-process Redis sorted-set fake that implements only the commands the
 * limiter's Lua scripts use. Two RateLimiter instances pointed at the same fake
 * share one backing store, simulating two processes (a restart) against the same
 * Redis. This is the durability guarantee under test.
 */
function createFakeRedis(): RateLimiterRedisClient {
  // key -> array of { member, score }
  const store = new Map<string, Array<{ member: string; score: number }>>();

  function getSet(key: string) {
    let set = store.get(key);
    if (!set) {
      set = [];
      store.set(key, set);
    }
    return set;
  }

  return {
    async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
      const key = String(args[0]);

      if (script.includes('DEL')) {
        store.delete(key);
        return 0;
      }

      if (script.includes("'EXPIRE'") && script.includes('ZCOUNT')) {
        // ENFORCE_SCRIPT: now, perMin, perHour, perDay, minCut, hourCut, dayCut, ttl, member
        const now = Number(args[1]);
        const perMin = Number(args[2]);
        const perHour = Number(args[3]);
        const perDay = Number(args[4]);
        const minCut = Number(args[5]);
        const hourCut = Number(args[6]);
        const dayCut = Number(args[7]);
        const member = String(args[9]);
        let set = getSet(key);
        set = set.filter((e) => e.score > dayCut);
        store.set(key, set);
        const lastMin = set.filter((e) => e.score >= minCut).length;
        const lastHour = set.filter((e) => e.score >= hourCut).length;
        const dayCount = set.length;
        if (lastMin >= perMin || lastHour >= perHour || dayCount >= perDay) {
          return [0, lastMin, lastHour, dayCount];
        }
        set.push({ member, score: now });
        return [1, lastMin, lastHour, dayCount + 1];
      }

      // RECORD_SCRIPT: now, dayCut, ttl, member
      const now = Number(args[1]);
      const dayCut = Number(args[2]);
      const member = String(args[4]);
      let set = getSet(key);
      set = set.filter((e) => e.score > dayCut);
      set.push({ member, score: now });
      store.set(key, set);
      return set.length;
    },
  };
}

describe('RateLimiter (durable, mocked Redis)', () => {
  it('shares the daily count across a simulated restart', async () => {
    const redis = createFakeRedis();
    const thresholds = { perMinute: 1000, perHour: 1000, perDay: 5 };

    // First "process": record up to the daily cap minus one.
    const first = new RateLimiter(thresholds, { redisClient: redis });
    for (let i = 0; i < 4; i++) {
      await first.enforce();
    }

    // Second "process" (restart) shares the same Redis store. The 5th action
    // takes it to the cap; the 6th must be rejected even though this instance's
    // own in-memory log is empty.
    const second = new RateLimiter(thresholds, { redisClient: redis });
    await second.enforce(); // 5th overall
    await expect(second.enforce()).rejects.toThrow(RateLimitExceededError);
  });

  it('still enforces the per-minute window via the durable store', async () => {
    const redis = createFakeRedis();
    const limiter = new RateLimiter(
      { perMinute: 2, perHour: 100, perDay: 100 },
      { redisClient: redis }
    );
    await limiter.enforce();
    await limiter.enforce();
    await expect(limiter.enforce()).rejects.toThrow(RateLimitExceededError);
  });

  it('fails closed (throws) when a configured Redis errors instead of falling back to in-memory', async () => {
    const failing: RateLimiterRedisClient = {
      eval: async () => {
        throw new Error('redis down');
      },
    };
    const limiter = new RateLimiter(undefined, { redisClient: failing });
    // A configured-but-failing Redis must fail closed: falling back to a fresh
    // in-memory counter would let a user already at the durable cap slip past.
    await expect(limiter.enforce()).rejects.toThrow('redis down');
  });

  it('uses in-memory when no Redis client is available', async () => {
    const limiter = new RateLimiter(
      { perMinute: 2, perHour: 100, perDay: 100 },
      {
        redisClient: null,
      }
    );
    await limiter.enforce();
    await limiter.enforce();
    await expect(limiter.enforce()).rejects.toThrow(RateLimitExceededError);
  });
});
