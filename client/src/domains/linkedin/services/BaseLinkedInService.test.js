import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseLinkedInService } from './BaseLinkedInService.js';
import { BrowserSessionManager } from '../../session/services/browserSessionManager.js';
import { buildPuppeteerPage } from '../../../test-utils/index.ts';

// Mock dependencies
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../storage/services/dynamoDBService.js', () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      setAuthToken: vi.fn(),
      upsertEdgeStatus: vi.fn().mockResolvedValue(true),
      updateMessages: vi.fn().mockResolvedValue(true),
    };
  }),
}));

vi.mock('../../session/services/browserSessionManager.js', () => ({
  BrowserSessionManager: {
    getInstance: vi.fn(),
    cleanup: vi.fn(),
    isSessionHealthy: vi.fn(),
    getHealthStatus: vi.fn(),
    getSessionMetrics: vi.fn().mockReturnValue({ recordOperation: vi.fn() }),
    recordError: vi.fn(),
  },
}));

vi.mock('../../navigation/services/linkedinNavigationService.js', () => ({
  LinkedInNavigationService: vi.fn().mockImplementation(function () {
    return { navigateToProfile: vi.fn().mockResolvedValue(true) };
  }),
}));

vi.mock('../../messaging/services/linkedinMessagingService.js', () => ({
  LinkedInMessagingService: vi.fn().mockImplementation(function () {
    return { sendMessage: vi.fn() };
  }),
}));

vi.mock('../../connections/services/linkedinConnectionService.js', () => ({
  LinkedInConnectionService: vi.fn().mockImplementation(function () {
    return { sendConnectionRequest: vi.fn() };
  }),
}));

vi.mock('../../messaging/services/linkedinMessageScraperService.js', () => ({
  LinkedInMessageScraperService: vi.fn().mockImplementation(function () {
    return { scrapeConversationThread: vi.fn().mockResolvedValue([]) };
  }),
}));

vi.mock('../../automation/services/puppeteerService.js', () => ({
  PuppeteerService: vi.fn(),
}));

const { mockResolver } = vi.hoisted(() => ({
  mockResolver: {
    resolve: vi.fn(),
    resolveWithWait: vi.fn(),
  },
}));

vi.mock('../selectors/index.js', () => ({
  linkedinResolver: mockResolver,
  linkedinSelectors: {},
}));

vi.mock('#shared-config/configManager.js', () => ({
  default: {
    getErrorHandlingConfig: vi.fn().mockReturnValue({ retryAttempts: 3, retryBaseDelay: 1000 }),
    get: vi.fn((key, def) => def),
    setOverride: vi.fn(),
  },
}));

vi.mock('#shared-config/index.js', () => ({
  default: {
    linkedin: { baseUrl: 'https://www.linkedin.com' },
  },
}));

describe('BaseLinkedInService', () => {
  let service;
  let mockPage;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockPage = buildPuppeteerPage();
    const mockSession = {
      getPage: () => mockPage,
      goto: vi.fn().mockResolvedValue({ ok: () => true }),
      waitForSelector: vi.fn().mockResolvedValue({}),
    };
    BrowserSessionManager.getInstance.mockResolvedValue(mockSession);

    service = new BaseLinkedInService();
  });

  describe('constructor', () => {
    it('should initialize with default dependencies', () => {
      expect(service.sessionManager).toBe(BrowserSessionManager);
      expect(service._rateLimiter).toBeDefined();
    });

    it('should accept injected dependencies', () => {
      const mockSessionManager = { getInstance: vi.fn() };
      const customService = new BaseLinkedInService({
        sessionManager: mockSessionManager,
      });
      expect(customService.sessionManager).toBe(mockSessionManager);
    });
  });

  describe('_paced', () => {
    it('should execute callback after delay', async () => {
      const callback = vi.fn().mockResolvedValue('result');
      const promise = service._paced(100, 200, callback);

      // Advance timers to resolve the random delay
      await vi.advanceTimersByTimeAsync(300);

      const result = await promise;
      expect(callback).toHaveBeenCalled();
      expect(result).toBe('result');
    });
  });

  describe('_enforceRateLimit', () => {
    it('should not throw when under limit', () => {
      expect(() => service._enforceRateLimit()).not.toThrow();
    });

    it('should throw LinkedInError when rate limit exceeded', async () => {
      // Force the rate limiter to throw
      service._rateLimiter.enforce = vi.fn().mockImplementation(() => {
        const { RateLimitExceededError } = require('../../automation/utils/rateLimiter.js');
        throw new RateLimitExceededError('Rate limit exceeded');
      });

      expect(() => service._enforceRateLimit()).toThrow();
    });
  });

  describe('initializeBrowserSession', () => {
    it('should delegate to sessionManager with reinitialize flag', async () => {
      await service.initializeBrowserSession();
      expect(BrowserSessionManager.getInstance).toHaveBeenCalledWith({
        reinitializeIfUnhealthy: true,
      });
    });
  });

  describe('getBrowserSession', () => {
    it('should delegate to sessionManager without reinitialize flag', async () => {
      await service.getBrowserSession();
      expect(BrowserSessionManager.getInstance).toHaveBeenCalledWith({
        reinitializeIfUnhealthy: false,
      });
    });
  });

  describe('closeBrowserSession', () => {
    it('should delegate to sessionManager cleanup', async () => {
      await service.closeBrowserSession();
      expect(BrowserSessionManager.cleanup).toHaveBeenCalled();
    });
  });

  describe('isSessionActive', () => {
    it('should check health via manager', async () => {
      BrowserSessionManager.isSessionHealthy.mockResolvedValue(true);
      const active = await service.isSessionActive();
      expect(active).toBe(true);
    });
  });

  describe('getSessionStatus', () => {
    it('should return expected structure with humanBehavior', async () => {
      BrowserSessionManager.getHealthStatus.mockResolvedValue({ isHealthy: true });
      const status = await service.getSessionStatus();

      expect(status).toHaveProperty('isHealthy', true);
      expect(status).toHaveProperty('humanBehavior');
      expect(status.humanBehavior).toHaveProperty('totalActions', 0);
      expect(status.humanBehavior).toHaveProperty('suspiciousActivity');
      expect(status.humanBehavior.suspiciousActivity.isSuspicious).toBe(false);
    });
  });

  describe('validateWorkflowParameters', () => {
    it('should validate messaging workflow - valid', () => {
      const result = service.validateWorkflowParameters('messaging', {
        recipientProfileId: 'test-id',
        messageContent: 'Hello!',
      });
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate messaging workflow - missing recipientProfileId', () => {
      const result = service.validateWorkflowParameters('messaging', {
        messageContent: 'Hello!',
      });
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('recipientProfileId is required for messaging workflow');
    });

    it('should validate connection workflow - missing profileId', () => {
      const result = service.validateWorkflowParameters('connection', {});
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('profileId is required for connection workflow');
    });

    it('should validate post workflow - missing content', () => {
      const result = service.validateWorkflowParameters('post', {
        content: '',
      });
      expect(result.isValid).toBe(false);
    });

    it('should return errors for unknown workflow type', () => {
      const result = service.validateWorkflowParameters('unknown', {});
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('Unknown workflow type');
    });
  });

  describe('delay', () => {
    it('should delay for specified milliseconds', async () => {
      const promise = service.delay(100);
      await vi.advanceTimersByTimeAsync(100);
      await promise; // should resolve
    });
  });

  describe('findElementBySelectors', () => {
    it('should return found element and selector', async () => {
      const mockElement = { click: vi.fn() };
      const mockSession = {
        getPage: () => mockPage,
        waitForSelector: vi.fn().mockResolvedValue(mockElement),
      };
      BrowserSessionManager.getInstance.mockResolvedValue(mockSession);

      const result = await service.findElementBySelectors(['.selector1'], 1000);
      expect(result.element).toBe(mockElement);
      expect(result.selector).toBe('.selector1');
    });

    it('should return nulls when no selector matches', async () => {
      const mockSession = {
        getPage: () => mockPage,
        waitForSelector: vi.fn().mockRejectedValue(new Error('not found')),
      };
      BrowserSessionManager.getInstance.mockResolvedValue(mockSession);

      const result = await service.findElementBySelectors(['.selector1'], 1000);
      expect(result.element).toBeNull();
      expect(result.selector).toBeNull();
    });
  });

  describe('checkSuspiciousActivity', () => {
    it('should return safe default', async () => {
      const result = await service.checkSuspiciousActivity();
      expect(result.isSuspicious).toBe(false);
      expect(result.patterns).toEqual([]);
    });
  });

  describe('_applyControlPlaneRateLimits', () => {
    it('should skip when no controlPlaneService configured', async () => {
      // controlPlaneService is null by default
      await service._applyControlPlaneRateLimits('test');
      // Should not throw
    });
  });

  describe('_reportInteraction', () => {
    it('should skip when no controlPlaneService configured', () => {
      service._reportInteraction('test');
      // Should not throw
    });
  });
});
