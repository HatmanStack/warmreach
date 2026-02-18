import { logger } from '#utils/logger.js';

/**
 * Extract user ID from request for rate limiting.
 * Exported for use by Redis rate limiter.
 *
 * @param {import('express').Request} req - Express request object
 * @returns {string} User identifier
 */
export function extractUserId(req) {
  // Try to extract from decoded JWT (set by auth middleware)
  if (req.user?.sub) return req.user.sub;
  if (req.user?.id) return req.user.id;

  // Fallback to Authorization header hash (for unprocessed JWTs)
  const authHeader = req.headers?.authorization || '';
  if (authHeader) {
    // Use last 8 chars of token as pseudo-ID (avoids storing full token)
    return `anon:${authHeader.slice(-8)}`;
  }

  // Fallback to IP
  return `ip:${req.ip || req.connection?.remoteAddress || 'unknown'}`;
}

/**
 * In-memory per-user rate limiter middleware.
 *
 * Tracks request counts per user (extracted from JWT) with a sliding window.
 * Returns 429 with Retry-After header when limit is exceeded.
 *
 * @param {Object} options
 * @param {number} options.windowMs - Window size in milliseconds (default: 60000)
 * @param {number} options.max - Max requests per window per user (default: 30)
 * @param {string} options.name - Name for logging (default: 'rate-limiter')
 */
export function createRateLimiter(options = {}) {
  const { windowMs = 60000, max = 30, name = 'rate-limiter' } = options;

  // Map<userId, { count, windowStart }>
  const userWindows = new Map();

  // Periodic cleanup of expired windows (every 5 minutes)
  const CLEANUP_INTERVAL = 5 * 60 * 1000;
  let lastCleanup = Date.now();

  function cleanup() {
    const now = Date.now();
    if (now - lastCleanup < CLEANUP_INTERVAL) return;
    lastCleanup = now;
    for (const [userId, window] of userWindows) {
      if (now - window.windowStart > windowMs * 2) {
        userWindows.delete(userId);
      }
    }
  }

  return function rateLimiterMiddleware(req, res, next) {
    cleanup();

    const userId = extractUserId(req);
    const now = Date.now();

    let window = userWindows.get(userId);
    if (!window || now - window.windowStart > windowMs) {
      // New window
      window = { count: 0, windowStart: now };
      userWindows.set(userId, window);
    }

    window.count++;

    if (window.count > max) {
      const retryAfter = Math.ceil((window.windowStart + windowMs - now) / 1000);
      logger.warn(`${name}: Rate limit exceeded`, { userId, count: window.count, max, retryAfter });
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter,
        message: `Rate limit exceeded. Try again in ${retryAfter}s.`,
      });
    }

    // Add rate limit headers
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - window.count)));
    res.set('X-RateLimit-Reset', String(Math.ceil((window.windowStart + windowMs) / 1000)));

    next();
  };
}
