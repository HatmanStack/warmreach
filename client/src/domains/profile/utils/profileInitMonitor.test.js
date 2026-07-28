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

  describe('recordConnection', () => {
    beforeEach(() => {
      profileInitMonitor.metrics.connections.processed = 0;
      profileInitMonitor.metrics.connections.skipped = 0;
      profileInitMonitor.metrics.connections.errors = 0;
      delete profileInitMonitor.metrics.connections.error;
    });

    it("counts an 'error' outcome on the errors counter", () => {
      profileInitMonitor.startRequest('req1');
      profileInitMonitor.recordConnection('req1', 'someone-123', 'error', 0);

      expect(profileInitMonitor.metrics.connections.errors).toBe(1);
      // The counter is `errors`; an `error` key would mean the outcome name
      // leaked through as a fresh (NaN) property instead of being counted.
      expect(profileInitMonitor.metrics.connections).not.toHaveProperty('error');
    });

    it("counts an 'error' outcome on the per-request counters too", () => {
      profileInitMonitor.startRequest('req1');
      profileInitMonitor.recordConnection('req1', 'someone-123', 'error', 0);

      const active = profileInitMonitor.activeRequests.get('req1');
      expect(active.connections.errors).toBe(1);
      expect(active.connections).not.toHaveProperty('error');
    });

    it('counts processed and skipped outcomes', () => {
      profileInitMonitor.startRequest('req1');
      profileInitMonitor.recordConnection('req1', 'a-1', 'processed', 0);
      profileInitMonitor.recordConnection('req1', 'b-2', 'skipped', 0);

      expect(profileInitMonitor.metrics.connections.processed).toBe(1);
      expect(profileInitMonitor.metrics.connections.skipped).toBe(1);
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
