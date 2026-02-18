import Redis from 'ioredis';
import { logger } from '#utils/logger.js';
import { extractUserId, createRateLimiter as createMemoryRateLimiter } from './rateLimiter.js';

/**
 * Redis client singleton
 */
let redisClient = null;

/**
 * Get or create Redis client.
 * Returns null if REDIS_URL is not configured.
 *
 * @returns {Redis | null} Redis client or null
 */
function getRedisClient() {
  if (redisClient) return redisClient;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    logger.debug('REDIS_URL not configured, rate limiter will use memory fallback');
    return null;
  }

  try {
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
      retryStrategy: (times) => {
        if (times > 3) {
          logger.error('Redis connection failed after 3 retries');
          return null; // Stop retrying
        }
        return Math.min(times * 100, 3000);
      },
    });

    redisClient.on('error', (err) => {
      logger.error('Redis connection error', { error: err.message });
    });

    redisClient.on('connect', () => {
      logger.info('Redis connected for rate limiting');
    });

    return redisClient;
  } catch (error) {
    logger.error('Failed to create Redis client', { error: error.message });
    return null;
  }
}

/**
 * Redis-backed rate limiter with memory fallback.
 *
 * Uses Redis INCR with TTL for distributed rate limiting.
 * Falls back to in-memory rate limiting if Redis is unavailable.
 *
 * @param {Object} options
 * @param {number} options.windowMs - Window size in milliseconds (default: 60000)
 * @param {number} options.max - Max requests per window per user (default: 30)
 * @param {string} options.name - Name for logging and Redis key prefix (default: 'rate-limiter')
 */
export function createRedisRateLimiter(options = {}) {
  const { windowMs = 60000, max = 30, name = 'rate-limiter' } = options;
  const windowSec = Math.ceil(windowMs / 1000);

  // Create memory fallback limiter
  const memoryFallback = createMemoryRateLimiter(options);

  return async function redisRateLimiterMiddleware(req, res, next) {
    const redis = getRedisClient();

    // Fall back to memory if Redis unavailable
    if (!redis) {
      return memoryFallback(req, res, next);
    }

    const userId = extractUserId(req);
    const key = `ratelimit:${name}:${userId}`;

    try {
      // Atomic increment and TTL check
      const multi = redis.multi();
      multi.incr(key);
      multi.ttl(key);

      const results = await multi.exec();

      // results = [[err, value], [err, value]] - check for per-command errors
      if (!results || results.length < 2) {
        throw new Error('Unexpected Redis multi.exec() result');
      }

      const [incrResult, ttlResult] = results;
      if (incrResult[0]) {
        throw new Error(`Redis INCR failed: ${incrResult[0].message}`);
      }
      if (ttlResult[0]) {
        throw new Error(`Redis TTL failed: ${ttlResult[0].message}`);
      }

      const count = incrResult[1];
      const ttl = ttlResult[1];

      // Set TTL on first request in window
      if (ttl === -1) {
        await redis.expire(key, windowSec);
      }

      // Calculate remaining and reset time
      const remaining = Math.max(0, max - count);
      const resetTime = Date.now() + (ttl > 0 ? ttl * 1000 : windowMs);

      // Set rate limit headers
      res.set('X-RateLimit-Limit', String(max));
      res.set('X-RateLimit-Remaining', String(remaining));
      res.set('X-RateLimit-Reset', String(Math.ceil(resetTime / 1000)));

      // Check if limit exceeded
      if (count > max) {
        const retryAfter = ttl > 0 ? ttl : windowSec;
        logger.warn(`${name}: Rate limit exceeded (Redis)`, { userId, count, max, retryAfter });
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({
          error: 'Too many requests',
          retryAfter,
          message: `Rate limit exceeded. Try again in ${retryAfter}s.`,
        });
      }

      next();
    } catch (error) {
      // Log error and fall back to memory
      logger.warn('Redis rate limit check failed, using memory fallback', {
        error: error.message,
        userId,
      });
      return memoryFallback(req, res, next);
    }
  };
}

/**
 * Close Redis connection gracefully.
 * Call during server shutdown.
 */
export async function closeRedisConnection() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info('Redis connection closed');
  }
}

export default createRedisRateLimiter;
