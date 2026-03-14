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

/**
 * Rate limiter that enforces per-minute, per-hour, and per-day action limits.
 * Tracks action timestamps and prunes entries older than 24 hours.
 */
export class RateLimiter {
  private _actionLog: number[] = [];
  private _thresholds: Required<RateLimiterThresholds>;

  constructor(thresholds?: RateLimiterThresholds) {
    this._thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * Check rate limits and record an action. Throws if any threshold is exceeded.
   */
  enforce(): void {
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
  recordAction(): void {
    const now = Date.now();
    this._actionLog = this._actionLog.filter((t) => now - t < MS_PER_DAY);
    this._actionLog.push(now);
  }

  /**
   * Clear the action log (useful for testing).
   */
  reset(): void {
    this._actionLog = [];
  }
}
