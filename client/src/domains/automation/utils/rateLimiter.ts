/**
 * Custom error for rate limit violations.
 * Separate from LinkedInError to avoid circular dependencies.
 */
export class RateLimitExceededError extends Error {
  code: string;

  constructor(message: string) {
    super(message);
    this.name = 'RateLimitExceededError';
    this.code = 'RATE_LIMIT_EXCEEDED';
  }
}

import { logger } from '#utils/logger.js';
import { getRedisClient } from '../../../shared/middleware/redisRateLimiter.js';

interface RateLimiterThresholds {
  perMinute?: number;
  perHour?: number;
  perDay?: number;
}

const DEFAULT_THRESHOLDS: Required<RateLimiterThresholds> = {
  perMinute: 15,
  perHour: 200,
  perDay: 500,
};

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const DAY_TTL_SEC = 86_400;

/**
 * Minimal structural type for the bits of the ioredis client this limiter uses.
 * Declared locally so the domain util does not depend on the ioredis types and so
 * the client can be injected in tests.
 */
export interface RateLimiterRedisClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * Durably enforce the LinkedIn daily-action rate limit so it survives process
 * restarts (a crash-loop must not reset the counter and let a user blow past the
 * daily cap — see CLAUDE.md "respects rate limits"). The action timestamps live in
 * a Redis sorted set with a 24h TTL; this Lua script prunes entries older than a
 * day, counts the per-minute / per-hour / per-day windows, and — only if every
 * window is under its threshold — records the new action atomically. It returns
 * `{ allowed, lastMin, lastHour, dayCount }`.
 *
 * KEYS[1] = sorted-set key
 * ARGV: now, perMinute, perHour, perDay, minuteCutoff, hourCutoff, dayCutoff, ttl, member
 */
const ENFORCE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, tonumber(ARGV[7]))
local lastMin = redis.call('ZCOUNT', KEYS[1], tonumber(ARGV[5]), '+inf')
local lastHour = redis.call('ZCOUNT', KEYS[1], tonumber(ARGV[6]), '+inf')
local dayCount = redis.call('ZCARD', KEYS[1])
if lastMin >= tonumber(ARGV[2]) or lastHour >= tonumber(ARGV[3]) or dayCount >= tonumber(ARGV[4]) then
  return {0, lastMin, lastHour, dayCount}
end
redis.call('ZADD', KEYS[1], tonumber(ARGV[1]), ARGV[9])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[8]))
return {1, lastMin, lastHour, dayCount + 1}
`;

// Record-only Lua: prune + add without enforcing (mirrors recordAction()).
// ARGV: now, dayCutoff, ttl, member
const RECORD_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, tonumber(ARGV[2]))
redis.call('ZADD', KEYS[1], tonumber(ARGV[1]), ARGV[4])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return redis.call('ZCARD', KEYS[1])
`;

let _warnedNonDurable = false;
function warnNonDurableOnce(): void {
  if (_warnedNonDurable) return;
  _warnedNonDurable = true;
  logger.warn(
    'Rate limiter Redis backing unavailable; daily action cap is in-memory only and ' +
      'will reset on restart. Set REDIS_URL to make the cap durable.'
  );
}

/**
 * Rate limiter that enforces per-minute, per-hour, and per-day action limits.
 *
 * When Redis is configured (REDIS_URL), the action log is persisted to a Redis
 * sorted set so the daily cap survives process restarts. When Redis is
 * unavailable or unconfigured, it falls back to the previous in-memory behavior
 * (with a one-time warning that the cap is non-durable in that mode).
 */
export class RateLimiter {
  private _actionLog: number[] = [];
  private _thresholds: Required<RateLimiterThresholds>;
  private _redisKey: string;
  private _getRedis: () => RateLimiterRedisClient | null;
  // Monotonic suffix so two actions at the same millisecond get distinct
  // sorted-set members (ZADD would otherwise overwrite the duplicate score).
  private _seq = 0;
  // Per-instance nonce so members stay unique across RateLimiter instances that
  // share one Redis key: two instances acting at the same millisecond with the
  // same _seq would otherwise produce an identical member and ZADD would update
  // instead of add, undercounting the shared daily cap.
  private readonly _nonce = Math.random().toString(36).slice(2, 10);

  constructor(
    thresholds?: RateLimiterThresholds,
    options?: { redisKey?: string; redisClient?: RateLimiterRedisClient | null }
  ) {
    this._thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this._redisKey = options?.redisKey ?? 'ratelimit:linkedin-actions';
    // Allow explicit injection (tests); otherwise resolve the shared client lazily
    // so construction never forces a Redis connection.
    if (options && 'redisClient' in options) {
      const injected = options.redisClient ?? null;
      this._getRedis = () => injected;
    } else {
      this._getRedis = () => getRedisClient() as RateLimiterRedisClient | null;
    }
  }

  private _member(now: number): string {
    this._seq = (this._seq + 1) % 1_000_000;
    return `${now}-${this._nonce}-${this._seq}`;
  }

  /**
   * Check rate limits and record an action. Throws if any threshold is exceeded.
   * Uses the durable Redis store when available, otherwise in-memory.
   */
  async enforce(): Promise<void> {
    const redis = this._getRedis();
    if (redis) {
      try {
        const now = Date.now();
        const res = (await redis.eval(
          ENFORCE_SCRIPT,
          1,
          this._redisKey,
          String(now),
          String(this._thresholds.perMinute),
          String(this._thresholds.perHour),
          String(this._thresholds.perDay),
          String(now - MS_PER_MINUTE),
          String(now - MS_PER_HOUR),
          String(now - MS_PER_DAY),
          String(DAY_TTL_SEC),
          this._member(now)
        )) as [number, number, number, number];
        const allowed = Array.isArray(res) ? Number(res[0]) : 0;
        if (!allowed) {
          throw new RateLimitExceededError('Rate limit exceeded');
        }
        return;
      } catch (err: unknown) {
        if (err instanceof RateLimitExceededError) throw err;
        // Redis is configured (the durable cap is expected) but the call failed.
        // Fail CLOSED rather than fall back to a fresh in-memory counter: a user
        // already at the Redis-backed daily cap must not slip past during a Redis
        // outage, which would defeat the durability guarantee (CLAUDE.md "respects
        // rate limits"). In-memory enforcement is reserved for the unconfigured case.
        logger.error('Rate limiter Redis enforce failed; failing closed', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    } else {
      warnNonDurableOnce();
    }

    this._enforceInMemory();
  }

  private _enforceInMemory(): void {
    const now = Date.now();

    // Prune actions older than 24 hours
    this._actionLog = this._actionLog.filter((t) => now - t < MS_PER_DAY);

    const lastMin = this._actionLog.filter((t) => now - t < MS_PER_MINUTE).length;
    const lastHour = this._actionLog.filter((t) => now - t < MS_PER_HOUR).length;

    if (
      lastMin >= this._thresholds.perMinute ||
      lastHour >= this._thresholds.perHour ||
      this._actionLog.length >= this._thresholds.perDay
    ) {
      throw new RateLimitExceededError('Rate limit exceeded');
    }

    this._actionLog.push(now);
  }

  /**
   * Record an action timestamp without enforcing limits.
   * Prunes entries older than 24 hours to prevent unbounded growth.
   */
  async recordAction(): Promise<void> {
    const redis = this._getRedis();
    if (redis) {
      try {
        const now = Date.now();
        await redis.eval(
          RECORD_SCRIPT,
          1,
          this._redisKey,
          String(now),
          String(now - MS_PER_DAY),
          String(DAY_TTL_SEC),
          this._member(now)
        );
        return;
      } catch (err: unknown) {
        warnNonDurableOnce();
        logger.warn('Rate limiter Redis record failed, using in-memory fallback', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      warnNonDurableOnce();
    }

    const now = Date.now();
    this._actionLog = this._actionLog.filter((t) => now - t < MS_PER_DAY);
    this._actionLog.push(now);
  }

  /**
   * Clear the action log (useful for testing). Clears both the in-memory log and,
   * when available, the durable Redis key.
   */
  async reset(): Promise<void> {
    this._actionLog = [];
    const redis = this._getRedis();
    if (redis) {
      try {
        await redis.eval("return redis.call('DEL', KEYS[1])", 1, this._redisKey);
      } catch (err: unknown) {
        logger.warn('Rate limiter Redis reset failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
