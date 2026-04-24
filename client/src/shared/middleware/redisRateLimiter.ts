import Redis from 'ioredis';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '#utils/logger.js';
import { extractUserId, createRateLimiter as createMemoryRateLimiter } from './rateLimiter.js';

interface RateLimiterOptions {
  windowMs?: number;
  max?: number;
  name?: string;
}

type RedisClient = InstanceType<typeof Redis.default>;

let redisClient: RedisClient | null = null;
let redisFallbackCounter = 0;

export function getRedisFallbackCount(): number {
  return redisFallbackCounter;
}

export function resetRedisFallbackCount(): void {
  redisFallbackCounter = 0;
}

function getRedisClient(): RedisClient | null {
  if (redisClient) return redisClient;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    logger.debug('REDIS_URL not configured, rate limiter will use memory fallback');
    return null;
  }

  try {
    redisClient = new Redis.default(redisUrl, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
      retryStrategy: (times: number) => {
        if (times > 3) {
          logger.error('Redis connection failed after 3 retries');
          return null;
        }
        return Math.min(times * 100, 3000);
      },
    });

    redisClient.on('error', (err: Error) => {
      logger.error('Redis connection error', { error: err.message });
    });

    redisClient.on('connect', () => {
      logger.info('Redis connected for rate limiting');
    });

    return redisClient;
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('Failed to create Redis client', { error: error.message });
    return null;
  }
}

// Atomic INCR + set-expire-if-missing. Returns [count, ttl] so the caller can
// build rate-limit headers without a second round-trip. Running as a Lua script
// closes the TOCTTOU gap between a separate INCR, TTL read, and EXPIRE call.
const INCR_WITH_TTL_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl == -1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export function createRedisRateLimiter(options: RateLimiterOptions = {}) {
  const { windowMs = 60000, max = 30, name = 'rate-limiter' } = options;
  const windowSec = Math.ceil(windowMs / 1000);

  const memoryFallback = createMemoryRateLimiter(options);

  return async function redisRateLimiterMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const redis = getRedisClient();

    if (!redis) {
      memoryFallback(req, res, next);
      return;
    }

    const userId = extractUserId(req);
    const key = `ratelimit:${name}:${userId}`;

    try {
      const result = (await redis.eval(INCR_WITH_TTL_SCRIPT, 1, key, String(windowSec))) as [
        number,
        number,
      ];

      if (!Array.isArray(result) || result.length < 2) {
        throw new Error('Unexpected Redis eval result');
      }

      const [count, ttl] = result;

      const remaining = Math.max(0, max - count);
      const resetTime = Date.now() + (ttl > 0 ? ttl * 1000 : windowMs);

      res.set('X-RateLimit-Limit', String(max));
      res.set('X-RateLimit-Remaining', String(remaining));
      res.set('X-RateLimit-Reset', String(Math.ceil(resetTime / 1000)));

      if (count > max) {
        const retryAfter = ttl > 0 ? ttl : windowSec;
        logger.warn(`${name}: Rate limit exceeded (Redis)`, { userId, count, max, retryAfter });
        res.set('Retry-After', String(retryAfter));
        return void res.status(429).json({
          error: 'Too many requests',
          retryAfter,
          message: `Rate limit exceeded. Try again in ${retryAfter}s.`,
        });
      }

      next();
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      redisFallbackCounter += 1;
      logger.warn('Redis rate limit check failed, using memory fallback', {
        error: error.message,
        userId,
        fallbackCount: redisFallbackCounter,
      });
      memoryFallback(req, res, next);
    }
  };
}

export async function closeRedisConnection(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info('Redis connection closed');
  }
}
