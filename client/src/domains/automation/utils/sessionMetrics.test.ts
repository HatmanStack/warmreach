import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionMetrics } from './sessionMetrics.ts';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

describe('SessionMetrics', () => {
  let metrics: SessionMetrics;
  let mockDetector: any;

  beforeEach(() => {
    mockDetector = {
      recordContentSignal: vi.fn(),
    };
    metrics = new SessionMetrics(mockDetector, {
      errorRateThreshold: 0.3,
      checkpointThreshold: 1,
      loginRedirectThreshold: 2,
    });
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('recordOperation', () => {
    it('calculates error rate and triggers signal if threshold exceeded', () => {
      // Record 10 operations, 4 failures (40%)
      for (let i = 0; i < 6; i++) metrics.recordOperation(true);
      for (let i = 0; i < 4; i++) metrics.recordOperation(false);
      
      expect(metrics.getErrorRate()).toBe(0.4);
      expect(mockDetector.recordContentSignal).toHaveBeenCalledWith('high-error-rate', expect.any(String));
    });

    it('does not trigger signal if under minimum operation count', () => {
      // Record 4 operations, 2 failures (50%)
      for (let i = 0; i < 2; i++) metrics.recordOperation(true);
      for (let i = 0; i < 2; i++) metrics.recordOperation(false);
      
      expect(metrics.getErrorRate()).toBe(0.5);
      expect(mockDetector.recordContentSignal).not.toHaveBeenCalled();
    });

    it('filters operations by window', () => {
      for (let i = 0; i < 5; i++) metrics.recordOperation(false);
      expect(metrics.getErrorRate()).toBe(1.0);
      
      // Advance 6 minutes (beyond 5m window)
      vi.advanceTimersByTime(6 * 60 * 1000);
      expect(metrics.getErrorRate()).toBe(0);
    });
  });

  describe('recordCheckpoint', () => {
    it('triggers signal after multiple checkpoints', () => {
      metrics.recordCheckpoint(); // 1st is fine
      expect(mockDetector.recordContentSignal).not.toHaveBeenCalled();
      
      metrics.recordCheckpoint(); // 2nd triggers
      expect(mockDetector.recordContentSignal).toHaveBeenCalledWith('frequent-checkpoints', expect.any(String));
    });
  });

  describe('recordLoginRedirect', () => {
    it('triggers signal after 3 login redirects', () => {
      metrics.recordLoginRedirect();
      metrics.recordLoginRedirect();
      expect(mockDetector.recordContentSignal).not.toHaveBeenCalled();
      
      metrics.recordLoginRedirect(); // 3rd triggers (threshold is 2)
      expect(mockDetector.recordContentSignal).toHaveBeenCalledWith('frequent-login-redirects', expect.any(String));
    });
  });

  describe('reset', () => {
    it('clears all metrics', () => {
      metrics.recordCheckpoint();
      metrics.reset();
      expect(metrics.getCheckpointCount()).toBe(0);
    });
  });
});
