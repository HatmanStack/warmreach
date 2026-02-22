import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('#shared-config/index.js', () => ({
  default: {
    linkedin: { baseUrl: 'https://www.linkedin.com' },
    linkedinInteractions: {
      retryAttempts: 3,
      retryBaseDelay: 100,
    },
  },
}));

vi.mock('#shared-config/configManager.js', () => ({
  default: {
    getErrorHandlingConfig: () => ({ retryAttempts: 3, retryBaseDelay: 100 }),
    get: vi.fn((key, def) => def),
  },
}));

vi.mock('../../storage/services/dynamoDBService.js', () => ({
  default: class {
    setAuthToken() {}
    upsertEdgeStatus() {}
  },
}));

vi.mock('../../session/services/browserSessionManager.js', () => ({
  BrowserSessionManager: {
    getInstance: vi.fn(),
    cleanup: vi.fn(),
    isSessionHealthy: vi.fn(() => true),
    getHealthStatus: vi.fn(() => ({})),
    recordError: vi.fn(),
    lastActivity: null,
  },
}));

vi.mock('../../navigation/services/linkedinNavigationService.js', () => ({
  LinkedInNavigationService: class {},
}));

vi.mock('../../messaging/services/linkedinMessagingService.js', () => ({
  LinkedInMessagingService: class {},
}));

vi.mock('../../connections/services/linkedinConnectionService.js', () => ({
  LinkedInConnectionService: class {},
}));

vi.mock('../../messaging/services/linkedinMessageScraperService.js', () => ({
  LinkedInMessageScraperService: class {},
}));

const { LinkedInInteractionService } = await import('./linkedinInteractionService.js');

describe('LinkedInInteractionService anti-spam guards', () => {
  let service;

  beforeEach(() => {
    service = new LinkedInInteractionService();
  });

  describe('_enforceRateLimit', () => {
    it('should allow actions under limits', () => {
      expect(() => service._enforceRateLimit()).not.toThrow();
      expect(service._actionLog).toHaveLength(1);
    });

    it('should track multiple actions', () => {
      for (let i = 0; i < 10; i++) {
        service._enforceRateLimit();
      }
      expect(service._actionLog).toHaveLength(10);
    });

    it('should throw at per-minute ceiling (15)', () => {
      for (let i = 0; i < 15; i++) {
        service._enforceRateLimit();
      }
      expect(() => service._enforceRateLimit()).toThrow('Rate limit exceeded');
    });

    it('should throw at per-hour ceiling (200)', () => {
      // Simulate 200 actions spread across the last hour (but not last minute)
      const now = Date.now();
      service._actionLog = Array.from(
        { length: 200 },
        (_, i) => now - 120000 - i * 10 // 2+ minutes ago, within the hour
      );
      expect(() => service._enforceRateLimit()).toThrow('Rate limit exceeded');
    });

    it('should throw at daily ceiling (500)', () => {
      const now = Date.now();
      service._actionLog = Array.from(
        { length: 500 },
        (_, i) => now - 7200000 - i * 100 // 2+ hours ago, within 24h
      );
      expect(() => service._enforceRateLimit()).toThrow('Rate limit exceeded');
    });

    it('should expire entries older than 24 hours', () => {
      const now = Date.now();
      service._actionLog = [
        now - 90000000, // >24h ago
        now - 90000001,
        now - 1000, // recent
      ];
      service._enforceRateLimit();
      // Old entries filtered out; new one added = 2 total
      expect(service._actionLog).toHaveLength(2);
    });
  });

  describe('_paced', () => {
    it('should execute the callback and return its result', async () => {
      const result = await service._paced(0, 0, () => Promise.resolve('done'));
      expect(result).toBe('done');
    });

    it('should propagate errors from the callback', async () => {
      await expect(service._paced(0, 0, () => Promise.reject(new Error('fail')))).rejects.toThrow(
        'fail'
      );
    });
  });
});
