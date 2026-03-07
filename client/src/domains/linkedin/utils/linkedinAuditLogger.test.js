import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LinkedInAuditLogger } from './linkedinAuditLogger.js';
import { logger } from '#utils/logger.js';

// Mock dependencies
vi.mock('#utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('LinkedInAuditLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('logInteractionAttempt', () => {
    it('should log attempt and redact sensitive content', () => {
      const context = { userId: 'u1', messageContent: 'secret', content: 'private' };
      LinkedInAuditLogger.logInteractionAttempt('sendMessage', context, 'req1');

      expect(logger.info).toHaveBeenCalledWith(
        'LinkedIn interaction attempt',
        expect.objectContaining({
          eventType: 'INTERACTION_ATTEMPT',
          requestId: 'req1',
          userId: 'u1',
          context: expect.objectContaining({
            messageContent: '[REDACTED]',
            content: '[REDACTED]',
          }),
        })
      );
    });
  });

  describe('logInteractionSuccess', () => {
    it('should log success with duration', () => {
      const result = { success: true };
      const context = { userId: 'u1', duration: 100, profileId: 'p1' };
      LinkedInAuditLogger.logInteractionSuccess('addConnection', result, context, 'req1');

      expect(logger.info).toHaveBeenCalledWith(
        'LinkedIn interaction success',
        expect.objectContaining({
          eventType: 'INTERACTION_SUCCESS',
          result: expect.objectContaining({
            duration: 100,
          }),
        })
      );
    });
  });

  describe('logInteractionFailure', () => {
    it('should log failure with error details', () => {
      const error = new Error('fail');
      const context = { userId: 'u1', errorCategory: 'NETWORK' };
      LinkedInAuditLogger.logInteractionFailure('sendMessage', error, context, 'req1');

      expect(logger.error).toHaveBeenCalledWith(
        'LinkedIn interaction failure',
        expect.objectContaining({
          eventType: 'INTERACTION_FAILURE',
          error: expect.objectContaining({
            message: 'fail',
            category: 'NETWORK',
          }),
        })
      );
    });
  });

  describe('logSessionEvent', () => {
    it('should log session info with appropriate log level', () => {
      const sessionInfo = { isActive: true, isHealthy: false };
      LinkedInAuditLogger.logSessionEvent('error', sessionInfo, 'req1');

      expect(logger.error).toHaveBeenCalledWith(
        'LinkedIn session error',
        expect.objectContaining({
          eventType: 'SESSION_ERROR',
          sessionInfo: expect.objectContaining({
            isHealthy: false,
          }),
        })
      );
    });
  });
});
