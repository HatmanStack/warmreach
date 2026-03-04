import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { SignalDetector } from './signalDetector.ts';

describe('SignalDetector', () => {
  let detector: SignalDetector;

  beforeEach(() => {
    detector = new SignalDetector();
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('recordResponseTiming', () => {
    it('calculates baseline and ignores normal responses', () => {
      // Establish baseline
      for (let i = 0; i < 10; i++) {
        detector.recordResponseTiming('https://www.linkedin.com/api', 200);
      }

      detector.recordResponseTiming('https://www.linkedin.com/api', 300);
      const assessment = detector.assess();
      expect(assessment.signals.length).toBe(0);
    });

    it('records low signal for 2x baseline', () => {
      for (let i = 0; i < 10; i++) {
        detector.recordResponseTiming('https://www.linkedin.com/api', 200);
      }

      detector.recordResponseTiming('https://www.linkedin.com/api', 450);
      const assessment = detector.assess();
      expect(assessment.signals[0].type).toBe('slow-response');
      expect(assessment.signals[0].severity).toBe('low');
    });

    it('records medium signal for 4x baseline', () => {
      for (let i = 0; i < 10; i++) {
        detector.recordResponseTiming('https://www.linkedin.com/api', 200);
      }

      detector.recordResponseTiming('https://www.linkedin.com/api', 900);
      const assessment = detector.assess();
      expect(assessment.signals[0].severity).toBe('medium');
    });
  });

  describe('recordHttpStatus', () => {
    it('records high signal for 429', () => {
      detector.recordHttpStatus('https://api', 429);
      const assessment = detector.assess();
      expect(assessment.signals[0].type).toBe('http-429');
      expect(assessment.signals[0].severity).toBe('high');
    });

    it('records high signal for 503', () => {
      detector.recordHttpStatus('https://api', 503);
      expect(detector.assess().signals[0].severity).toBe('high');
    });

    it('records medium signal for other 5xx', () => {
      detector.recordHttpStatus('https://api', 500);
      expect(detector.assess().signals[0].severity).toBe('medium');
    });
  });

  describe('assess', () => {
    it('returns shouldPause: true for critical signals', () => {
      detector.recordContentSignal('checkpoint-detected', 'url');
      const assessment = detector.assess();
      expect(assessment.shouldPause).toBe(true);
      expect(assessment.reason).toContain('Critical signal detected');
    });

    it('returns shouldPause: true for 3 high signals', () => {
      detector.recordHttpStatus('https://api/1', 429);
      detector.recordHttpStatus('https://api/2', 429);
      detector.recordHttpStatus('https://api/3', 429);

      const assessment = detector.assess();
      expect(assessment.shouldPause).toBe(true);
      expect(assessment.reason).toContain('3 high-severity signals');
    });

    it('returns shouldPause: true at or above the threat level threshold (60)', () => {
      // 2 high (40) + 4 medium (20) = 60
      detector.recordHttpStatus('api', 429); // high (20)
      detector.recordHttpStatus('api', 429); // high (20)
      detector.recordHttpStatus('api', 500); // medium (5)
      detector.recordHttpStatus('api', 500); // medium (5)
      detector.recordHttpStatus('api', 500); // medium (5)
      detector.recordHttpStatus('api', 500); // medium (5)

      const assessment = detector.assess();
      expect(assessment.threatLevel).toBe(60);
      expect(assessment.shouldPause).toBe(true);
    });

    it('evicts old signals from assessment window', () => {
      detector.recordContentSignal('checkpoint-detected', 'url');
      expect(detector.assess().shouldPause).toBe(true);

      // Advance 11 minutes
      vi.advanceTimersByTime(11 * 60 * 1000);

      const assessment = detector.assess();
      expect(assessment.shouldPause).toBe(false);
      expect(assessment.signals.length).toBe(0);
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      detector.recordHttpStatus('api', 429);
      detector.clear();
      expect(detector.assess().signals.length).toBe(0);
    });
  });
});
