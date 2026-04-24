import type { Request, Response, NextFunction } from 'express';
import { logger } from '#utils/logger.js';

interface AuthenticatedRequest extends Request {
  user?: { sub?: string; id?: string };
}

interface RateLimiterOptions {
  windowMs?: number;
  max?: number;
  name?: string;
}

interface RateWindow {
  count: number;
  windowStart: number;
}

export function extractUserId(req: AuthenticatedRequest): string {
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
  return `ip:${req.ip || 'unknown'}`;
}

interface RateLimiterHandle {
  (req: Request, res: Response, next: NextFunction): void;
  shutdown(): void;
}

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiterHandle {
  const { windowMs = 60000, max = 30, name = 'rate-limiter' } = options;

  const userWindows = new Map<string, RateWindow>();

  const CLEANUP_INTERVAL = 60 * 1000;

  // Periodic sweep independent of request traffic so the Map cannot grow
  // unbounded between bursts. unref() so the timer does not keep the process
  // alive on its own.
  const prune = setInterval(() => {
    const now = Date.now();
    for (const [userId, window] of userWindows) {
      if (now - window.windowStart > windowMs * 2) {
        userWindows.delete(userId);
      }
    }
  }, CLEANUP_INTERVAL);
  if (typeof prune.unref === 'function') {
    prune.unref();
  }

  const middleware = function rateLimiterMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const userId = extractUserId(req as AuthenticatedRequest);
    const now = Date.now();

    let window = userWindows.get(userId);
    if (!window || now - window.windowStart > windowMs) {
      window = { count: 0, windowStart: now };
      userWindows.set(userId, window);
    }

    window.count++;

    if (window.count > max) {
      const retryAfter = Math.ceil((window.windowStart + windowMs - now) / 1000);
      logger.warn(`${name}: Rate limit exceeded`, { userId, count: window.count, max, retryAfter });
      res.set('Retry-After', String(retryAfter));
      return void res.status(429).json({
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
  } as RateLimiterHandle;

  middleware.shutdown = function (): void {
    clearInterval(prune);
    userWindows.clear();
  };

  return middleware;
}
