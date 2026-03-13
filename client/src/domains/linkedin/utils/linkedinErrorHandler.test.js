import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LinkedInErrorHandler } from './linkedinErrorHandler.js';
import { LinkedInError } from './LinkedInError.js';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

describe('LinkedInErrorHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('categorizeError', () => {
    it('should categorize JWT errors as AUTHENTICATION', () => {
      const error = new Error('Invalid JWT token');
      const categorized = LinkedInErrorHandler.categorizeError(error);
      expect(categorized.category).toBe('AUTHENTICATION');
      expect(categorized.httpStatus).toBe(401);
    });

    it('should categorize browser crash as BROWSER', () => {
      const error = new Error('Browser session crashed');
      const categorized = LinkedInErrorHandler.categorizeError(error);
      expect(categorized.category).toBe('BROWSER');
      expect(categorized.httpStatus).toBe(503);
    });

    it('should categorize rate limit as RATE_LIMIT', () => {
      const error = new Error('Too many requests');
      const categorized = LinkedInErrorHandler.categorizeError(error);
      expect(categorized.category).toBe('RATE_LIMIT');
      expect(categorized.httpStatus).toBe(429);
    });

    it('should default to SYSTEM error', () => {
      const error = new Error('Something weird happened');
      const categorized = LinkedInErrorHandler.categorizeError(error);
      expect(categorized.category).toBe('SYSTEM');
      expect(categorized.httpStatus).toBe(500);
    });

    it('should categorize error by code when present', () => {
      const error = new Error('some message');
      error.code = 'LINKEDIN_RATE_LIMIT';
      const result = LinkedInErrorHandler.categorizeError(error);
      expect(result).toBe(LinkedInErrorHandler.ERROR_CODES.LINKEDIN_RATE_LIMIT);
      expect(result.category).toBe('RATE_LIMIT');
    });

    it('should fall through to string matching when code is not in ERROR_CODES', () => {
      const error = new Error('Browser session crashed');
      error.code = 'UNKNOWN_CODE_XYZ';
      const result = LinkedInErrorHandler.categorizeError(error);
      expect(result.category).toBe('BROWSER');
    });

    it('should categorize LinkedInError instance by code', () => {
      const error = new LinkedInError('something failed', 'ELEMENT_NOT_FOUND');
      const result = LinkedInErrorHandler.categorizeError(error);
      expect(result).toBe(LinkedInErrorHandler.ERROR_CODES.ELEMENT_NOT_FOUND);
      expect(result.category).toBe('BROWSER');
      expect(result.httpStatus).toBe(422);
    });

    it('should use code fast path over string matching', () => {
      // Message would match BROWSER_CRASH via string matching, but code wins
      const error = new LinkedInError('Browser session crashed', 'LINKEDIN_RATE_LIMIT');
      const result = LinkedInErrorHandler.categorizeError(error);
      expect(result).toBe(LinkedInErrorHandler.ERROR_CODES.LINKEDIN_RATE_LIMIT);
      expect(result.category).toBe('RATE_LIMIT');
    });
  });

  describe('createErrorResponse', () => {
    it('should return structured response', () => {
      const error = new Error('JWT expired');
      const result = LinkedInErrorHandler.createErrorResponse(error, { op: 'test' }, 'req1');

      expect(result.response.success).toBe(false);
      expect(result.response.error.code).toBe('JWT_INVALID');
      expect(result.response.error.requestId).toBe('req1');
      expect(result.httpStatus).toBe(401);
    });

    it('should include retry info for rate limits', () => {
      const error = new Error('rate limit');
      const result = LinkedInErrorHandler.createErrorResponse(error);

      expect(result.response.error.retryAfter).toBeDefined();
      expect(result.response.error.retryAt).toBeDefined();
    });
  });

  describe('calculateBackoffDelay', () => {
    it('should increase delay with attempt count', () => {
      const d1 = LinkedInErrorHandler.calculateBackoffDelay(1, 'RATE_LIMIT');
      const d2 = LinkedInErrorHandler.calculateBackoffDelay(2, 'RATE_LIMIT');
      expect(d2).toBeGreaterThan(d1);
    });
  });

  describe('isRecoverable', () => {
    it('should return true for network errors on first attempt', () => {
      const categorized = { category: 'NETWORK' };
      expect(LinkedInErrorHandler.isRecoverable(categorized, 1)).toBe(true);
    });

    it('should return false after 3 attempts', () => {
      const categorized = { category: 'NETWORK' };
      expect(LinkedInErrorHandler.isRecoverable(categorized, 3)).toBe(false);
    });
  });
});
