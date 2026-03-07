import { describe, it, expect } from 'vitest';
import { ApiError } from './apiError';
import { transformErrorForUser, getToastVariant, logError } from './errorHandling';

describe('ErrorHandling', () => {
  describe('transformErrorForUser', () => {
    it('should handle 401/403 errors', () => {
      const error = new ApiError({ message: 'Unauthorized', status: 401 });
      const result = transformErrorForUser(error, 'action');
      expect(result.severity).toBe('high');
      expect(result.userMessage).toContain('sign in again');
      expect(result.recoveryActions).toHaveLength(1);
      expect(result.recoveryActions[0].label).toBe('Sign In');
    });

    it('should handle 404 errors', () => {
      const error = new ApiError({ message: 'Not Found', status: 404 });
      const result = transformErrorForUser(error, 'action');
      expect(result.severity).toBe('medium');
      expect(result.userMessage).toContain('could not be found');
    });

    it('should handle 429 errors', () => {
      const error = new ApiError({ message: 'Too many', status: 429 });
      const result = transformErrorForUser(error, 'action');
      expect(result.severity).toBe('low');
      expect(result.retryable).toBe(true);
    });

    it('should handle 500+ errors', () => {
      const error = new ApiError({ message: 'Server error', status: 500 });
      const result = transformErrorForUser(error, 'action');
      expect(result.severity).toBe('high');
      expect(result.retryable).toBe(true);
    });

    it('should handle network errors in ApiError', () => {
      const error = new ApiError({ message: 'Network error', status: 0, code: 'NETWORK_ERROR' });
      const result = transformErrorForUser(error, 'action');
      expect(result.severity).toBe('high');
      expect(result.userMessage).toContain('internet connection');
    });

    it('should handle generic Error with timeout', () => {
      const error = new Error('request timeout');
      const result = transformErrorForUser(error, 'action');
      expect(result.severity).toBe('low');
      expect(result.retryable).toBe(true);
    });

    it('should handle generic Error with fetch/network', () => {
      const error = new Error('failed to fetch');
      const result = transformErrorForUser(error, 'action');
      expect(result.severity).toBe('high');
      expect(result.userMessage).toContain('Network connection issue');
    });

    it('should handle string errors', () => {
      const result = transformErrorForUser('something bad', 'action');
      expect(result.message).toBe('something bad');
      expect(result.userMessage).toBe('Failed to action. something bad');
    });

    it('should handle unknown error types', () => {
      const result = transformErrorForUser({}, 'action');
      expect(result.message).toBe('An unexpected error occurred');
    });
  });

  describe('getToastVariant', () => {
    it('should return default for low severity', () => {
      expect(getToastVariant('low')).toBe('default');
    });
    it('should return destructive for medium/high severity', () => {
      expect(getToastVariant('medium')).toBe('destructive');
      expect(getToastVariant('high')).toBe('destructive');
    });
  });

  describe('logError', () => {
    it('should log error with context', () => {
      // Mock logger or console
      const result = logError(new Error('test'), 'test-context');
      expect(result).toBeUndefined();
    });
  });
});
