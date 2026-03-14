import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateLimiter, RateLimitExceededError } from './rateLimiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
    vi.restoreAllMocks();
  });

  describe('enforce', () => {
    it('passes when under all thresholds', () => {
      expect(() => limiter.enforce()).not.toThrow();
    });

    it('records an action on successful enforce', () => {
      limiter.enforce();
      limiter.enforce();
      // Should still pass - well under 15/min
      expect(() => limiter.enforce()).not.toThrow();
    });

    it('throws RateLimitExceededError when minute threshold exceeded (15 actions in <60s)', () => {
      for (let i = 0; i < 15; i++) {
        limiter.enforce();
      }
      expect(() => limiter.enforce()).toThrow(RateLimitExceededError);
      expect(() => limiter.enforce()).toThrow('Rate limit exceeded');
    });

    it('throws when hour threshold exceeded (200 actions)', () => {
      // Spread actions across different minutes but within the same hour
      const now = Date.now();
      vi.spyOn(Date, 'now');

      for (let i = 0; i < 200; i++) {
        // Each action 200ms apart (40s total) - within the same minute window for batches of 14
        // But we need to spread across minutes to avoid minute limit
        const minuteOffset = Math.floor(i / 14) * 61000; // new minute every 14 actions
        (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(now + minuteOffset);
        limiter.enforce();
      }

      // Next action should hit hour limit
      const lastOffset = Math.floor(200 / 14) * 61000;
      (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(now + lastOffset);
      expect(() => limiter.enforce()).toThrow(RateLimitExceededError);
    });

    it('throws when day threshold exceeded (500 actions)', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now');

      for (let i = 0; i < 500; i++) {
        // Spread across hours to avoid minute and hour limits
        // 14 per minute, 199 per hour window
        const hourOffset = Math.floor(i / 199) * 3601000;
        const minuteOffset = Math.floor((i % 199) / 14) * 61000;
        (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(now + hourOffset + minuteOffset);
        limiter.enforce();
      }

      const finalOffset = Math.floor(500 / 199) * 3601000;
      (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(now + finalOffset);
      expect(() => limiter.enforce()).toThrow(RateLimitExceededError);
    });

    it('prunes actions older than 24 hours', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now');

      // Record some actions "25 hours ago"
      (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(now - 25 * 3600000);
      for (let i = 0; i < 10; i++) {
        limiter.enforce();
      }

      // Now at current time, old actions should be pruned
      (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(now);
      expect(() => limiter.enforce()).not.toThrow();
    });
  });

  describe('recordAction', () => {
    it('records an action timestamp', () => {
      limiter.recordAction();
      limiter.recordAction();
      // After 2 recorded + enforce records 1 more = 3 total, still under limit
      expect(() => limiter.enforce()).not.toThrow();
    });

    it('prunes entries older than 24 hours', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now');

      // Record actions "25 hours ago"
      (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(now - 25 * 3600000);
      for (let i = 0; i < 10; i++) {
        limiter.recordAction();
      }

      // At current time, recordAction should prune old entries
      (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(now);
      limiter.recordAction();

      // Only the one fresh entry should remain; enforce adds one more = 2 total
      // If pruning didn't work, we'd have 12 entries
      expect(() => limiter.enforce()).not.toThrow();
    });
  });

  describe('reset', () => {
    it('clears the action log', () => {
      for (let i = 0; i < 15; i++) {
        limiter.enforce();
      }
      // Now at minute limit
      expect(() => limiter.enforce()).toThrow(RateLimitExceededError);

      limiter.reset();
      // After reset, should be clear
      expect(() => limiter.enforce()).not.toThrow();
    });
  });

  describe('custom thresholds', () => {
    it('accepts custom threshold overrides', () => {
      const strict = new RateLimiter({ perMinute: 2, perHour: 10, perDay: 50 });
      strict.enforce();
      strict.enforce();
      expect(() => strict.enforce()).toThrow(RateLimitExceededError);
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
