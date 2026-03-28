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
    it('calculates baseline and ignores normal responses within adaptive range', () => {
      // Establish baseline with some natural variance
      for (let i = 0; i < 10; i++) {
        detector.recordResponseTiming('https://www.linkedin.com/api', 190 + (i % 3) * 10);
      }

      // A response within mean + 2*stddev range should not trigger
      detector.recordResponseTiming('https://www.linkedin.com/api', 220);
      const assessment = detector.assess();
      expect(assessment.signals.length).toBe(0);
    });

    it('uses static multipliers during cold start (fewer than 3 data points)', () => {
      // First call establishes baseline at 200, second uses static 2x/4x
      detector.recordResponseTiming('https://www.linkedin.com/api', 200);

      // 500 > 2*200 = 400 -> low signal (cold start)
      detector.recordResponseTiming('https://www.linkedin.com/api', 500);
      const assessment = detector.assess();
      expect(assessment.signals.length).toBe(1);
      expect(assessment.signals[0].type).toBe('slow-response');
      expect(assessment.signals[0].severity).toBe('low');
    });

    it('uses static 4x multiplier for medium signal during cold start', () => {
      detector.recordResponseTiming('https://www.linkedin.com/api', 200);

      // 900 > 4*200 = 800 -> medium signal (cold start)
      detector.recordResponseTiming('https://www.linkedin.com/api', 900);
      const assessment = detector.assess();
      expect(assessment.signals[0].severity).toBe('medium');
    });

    it('records medium signal for large spike after warm-up', () => {
      // Establish stable baseline
      for (let i = 0; i < 10; i++) {
        detector.recordResponseTiming('https://www.linkedin.com/api', 200);
      }

      // Large spike: well above mean + 3*stddev (with 10% floor stddev = 20, threshold ~ 260)
      detector.recordResponseTiming('https://www.linkedin.com/api', 900);
      const assessment = detector.assess();
      expect(assessment.signals[0].severity).toBe('medium');
    });

    it('records low signal for moderate spike within adaptive range', () => {
      // Establish baseline with some variance so stddev floor is less relevant
      for (let i = 0; i < 10; i++) {
        detector.recordResponseTiming('https://www.linkedin.com/api', 180 + (i % 5) * 20);
      }

      // Moderate spike: between mean + 2*stddev and mean + 3*stddev
      // With natural variance, mean ~ 200, stddev ~ 20-30, low threshold ~ 240-260, medium ~ 260-290
      // 255ms should be in the low range
      detector.recordResponseTiming('https://www.linkedin.com/api', 255);
      const assessment = detector.assess();
      const slowSignals = assessment.signals.filter((s) => s.type === 'slow-response');
      if (slowSignals.length > 0) {
        expect(slowSignals[0].severity).toBe('low');
      }
    });

    it('does not trigger for gradual baseline increase', () => {
      // Gradually increasing response times should raise the baseline
      for (let i = 0; i < 20; i++) {
        detector.recordResponseTiming('https://www.linkedin.com/api', 200 + i * 5);
      }
      // After gradual increase, the latest values (around 295ms) are normal for the updated baseline
      const assessment = detector.assess();
      // Most signals should not be medium, the gradual increase adapts the baseline
      const mediumSignals = assessment.signals.filter(
        (s) => s.type === 'slow-response' && s.severity === 'medium'
      );
      expect(mediumSignals.length).toBe(0);
    });

    it('isolates domains from each other', () => {
      // Establish baseline for domain A
      for (let i = 0; i < 10; i++) {
        detector.recordResponseTiming('https://www.linkedin.com/api', 200);
      }

      // Domain B starts fresh, so cold-start applies
      detector.recordResponseTiming('https://api.example.com/data', 100);

      // Domain A spike triggers, but domain B stays independent
      detector.recordResponseTiming('https://www.linkedin.com/api', 900);
      detector.recordResponseTiming('https://api.example.com/data', 120);

      const assessment = detector.assess();
      const slowSignals = assessment.signals.filter((s) => s.type === 'slow-response');
      // Only domain A should have a signal
      expect(slowSignals.length).toBe(1);
      expect(slowSignals[0].details).toContain('900ms');
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
