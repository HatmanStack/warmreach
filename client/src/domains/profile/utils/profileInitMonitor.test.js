import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { profileInitMonitor, stopMonitoring } from './profileInitMonitor.js';

// Mock dependencies
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

describe('ProfileInitMonitor', () => {
  beforeEach(() => {
    // We can't easily reset the singleton, but we can clear its state
    profileInitMonitor.metrics.requests.total = 0;
    profileInitMonitor.metrics.requests.successful = 0;
    profileInitMonitor.metrics.requests.failed = 0;
    profileInitMonitor.activeRequests.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopMonitoring();
  });

  describe('startRequest', () => {
    it('should track a new request', () => {
      profileInitMonitor.startRequest('req1', { user: 'test' });
      expect(profileInitMonitor.metrics.requests.total).toBe(1);
      expect(profileInitMonitor.activeRequests.has('req1')).toBe(true);
    });
  });

  describe('recordSuccess', () => {
    it('should update metrics on success', () => {
      profileInitMonitor.startRequest('req1');
      profileInitMonitor.recordSuccess('req1', { data: { processed: 5, skipped: 1, errors: 0 } });

      expect(profileInitMonitor.metrics.requests.successful).toBe(1);
      expect(profileInitMonitor.metrics.connections.processed).toBe(5);
      expect(profileInitMonitor.activeRequests.has('req1')).toBe(false);
    });
  });

  describe('recordFailure', () => {
    it('should update metrics on failure', () => {
      profileInitMonitor.startRequest('req1');
      profileInitMonitor.recordFailure('req1', new Error('fail'), {
        type: 'AuthError',
        isRecoverable: true,
      });

      expect(profileInitMonitor.metrics.requests.failed).toBe(1);
      expect(profileInitMonitor.metrics.errors.recoverableCount).toBe(1);
    });
  });

  describe('getMetrics', () => {
    it('should return calculated rates', () => {
      profileInitMonitor.startRequest('r1');
      profileInitMonitor.recordSuccess('r1');
      profileInitMonitor.startRequest('r2');
      profileInitMonitor.recordFailure('r2', new Error('f'), {});

      const metrics = profileInitMonitor.getMetrics();
      expect(metrics.successRate).toBe('50.00');
      expect(metrics.failureRate).toBe('50.00');
    });
  });
});
