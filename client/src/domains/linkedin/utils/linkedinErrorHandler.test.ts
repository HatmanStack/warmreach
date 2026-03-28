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

    // Registry pattern coverage: every ERROR_PATTERNS entry
    it.each([
      ['session expired', 'LINKEDIN_SESSION_EXPIRED', 'AUTHENTICATION'],
      ['user logged out', 'LINKEDIN_SESSION_EXPIRED', 'AUTHENTICATION'],
      ['authentication required', 'LINKEDIN_AUTH_REQUIRED', 'AUTHENTICATION'],
      ['please login first', 'LINKEDIN_AUTH_REQUIRED', 'AUTHENTICATION'],
      ['Browser window closed unexpectedly', 'BROWSER_CRASH', 'BROWSER'],
      ['operation timed out', 'BROWSER_TIMEOUT', 'BROWSER'],
      ['navigation to page failed', 'BROWSER_NAVIGATION_FAILED', 'BROWSER'],
      ['element not found on page', 'ELEMENT_NOT_FOUND', 'BROWSER'],
      ['CSS selector mismatch', 'ELEMENT_NOT_FOUND', 'BROWSER'],
      ['rate limit exceeded', 'LINKEDIN_RATE_LIMIT', 'RATE_LIMIT'],
      ['suspicious activity detected', 'LINKEDIN_SUSPICIOUS_ACTIVITY', 'RATE_LIMIT'],
      ['account restricted', 'LINKEDIN_SUSPICIOUS_ACTIVITY', 'RATE_LIMIT'],
      ['profile not found for user', 'PROFILE_NOT_FOUND', 'LINKEDIN'],
      ['user not found in directory', 'PROFILE_NOT_FOUND', 'LINKEDIN'],
      ['already connected to this person', 'ALREADY_CONNECTED', 'LINKEDIN'],
      ['connection exists already', 'ALREADY_CONNECTED', 'LINKEDIN'],
      ['message blocked by recipient', 'MESSAGE_BLOCKED', 'LINKEDIN'],
      ['messaging not allowed for user', 'MESSAGE_BLOCKED', 'LINKEDIN'],
      ['post creation failed', 'POST_CREATION_FAILED', 'LINKEDIN'],
      ['post had an error', 'POST_CREATION_FAILED', 'LINKEDIN'],
      ['network error occurred', 'NETWORK_ERROR', 'NETWORK'],
      ['ENOTFOUND linkedin.com', 'NETWORK_ERROR', 'NETWORK'],
      ['dns lookup failed', 'DNS_RESOLUTION_FAILED', 'NETWORK'],
      ['could not resolve host', 'DNS_RESOLUTION_FAILED', 'NETWORK'],
      ['out of memory', 'MEMORY_LIMIT_EXCEEDED', 'SYSTEM'],
      ['JavaScript heap exhausted', 'MEMORY_LIMIT_EXCEEDED', 'SYSTEM'],
      ['disk full', 'DISK_SPACE_LOW', 'SYSTEM'],
      ['insufficient space', 'DISK_SPACE_LOW', 'SYSTEM'],
    ])('pattern: "%s" -> %s (%s)', (message, expectedCode, expectedCategory) => {
      const result = LinkedInErrorHandler.categorizeError(new Error(message));
      expect(result).toBe(LinkedInErrorHandler.ERROR_CODES[expectedCode]);
      expect(result.category).toBe(expectedCategory);
    });

    it('should return FALLBACK_ERROR for unrecognized messages', () => {
      const result = LinkedInErrorHandler.categorizeError(
        new Error('completely unknown situation xyz')
      );
      expect(result).toBe(LinkedInErrorHandler.FALLBACK_ERROR);
      expect(result.category).toBe('SYSTEM');
      expect(result.httpStatus).toBe(500);
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
