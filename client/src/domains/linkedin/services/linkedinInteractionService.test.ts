import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LinkedInInteractionService } from './linkedinInteractionService.js';
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
    return {
      navigateToProfile: vi.fn().mockResolvedValue(true),
    };
  }),
}));

vi.mock('../../messaging/services/linkedinMessagingService.js', () => ({
  LinkedInMessagingService: vi.fn().mockImplementation(function () {
    return {
      sendMessage: vi.fn(),
    };
  }),
}));

vi.mock('../../connections/services/linkedinConnectionService.js', () => ({
  LinkedInConnectionService: vi.fn().mockImplementation(function () {
    return {
      sendConnectionRequest: vi.fn(),
    };
  }),
}));

vi.mock('../../messaging/services/linkedinMessageScraperService.js', () => ({
  LinkedInMessageScraperService: vi.fn().mockImplementation(function () {
    return {
      scrapeConversationThread: vi.fn().mockResolvedValue([]),
    };
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
    get: vi.fn((_key, def) => def),
  },
}));

vi.mock('#shared-config/index.js', () => ({
  default: {
    linkedin: { baseUrl: 'https://www.linkedin.com' },
  },
}));

describe('LinkedInInteractionService', () => {
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

    service = new LinkedInInteractionService();
  });

  describe('initializeBrowserSession', () => {
    it('should initialize session via manager', async () => {
      await service.initializeBrowserSession();
      expect(BrowserSessionManager.getInstance).toHaveBeenCalledWith({
        reinitializeIfUnhealthy: true,
      });
    });
  });

  describe('isSessionActive', () => {
    it('should check health via manager', async () => {
      BrowserSessionManager.isSessionHealthy.mockResolvedValue(true);
      const active = await service.isSessionActive();
      expect(active).toBe(true);
    });
  });

  describe('navigateToProfile', () => {
    it('should navigate to profile URL and verify page', async () => {
      mockResolver.resolveWithWait.mockResolvedValue({}); // indicator
      mockPage.url.mockReturnValue('https://www.linkedin.com/in/test');
      mockPage.evaluate.mockResolvedValue({
        ready: 'complete',
        main: true,
        anchors: 10,
        images: 5,
        height: 1000,
        isCheckpoint: false,
      });

      const promise = service.navigateToProfile('test-id');

      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(250);
      }

      const success = await promise;

      expect(success).toBe(true);
      // It navigates directly via session.goto
      const session = await BrowserSessionManager.getInstance();
      expect(session.goto).toHaveBeenCalledWith(
        expect.stringContaining('test-id'),
        expect.any(Object)
      );
    });
  });

  describe('sendMessage', () => {
    it('should delegate to messaging ops module', async () => {
      const messagingOps = await import('./linkedinMessagingOps.js');
      vi.spyOn(messagingOps, 'sendMessage').mockResolvedValue({
        messageId: 'm1',
        deliveryStatus: 'sent',
      });

      const result = await service.sendMessage('p1', 'hello', 'u1');

      expect(result.messageId).toBe('m1');
      expect(result.deliveryStatus).toBe('sent');
    });
  });

  describe('executeConnectionWorkflow', () => {
    it('should delegate to connection ops module', async () => {
      const connectionOps = await import('./linkedinConnectionOps.js');
      vi.spyOn(connectionOps, 'executeConnectionWorkflow').mockResolvedValue({
        requestId: 'r1',
        status: 'sent',
        confirmationFound: true,
      });

      const result = await service.executeConnectionWorkflow('p1', 'hi');

      expect(result.requestId).toBe('r1');
      expect(result.status).toBe('sent');
    });
  });

  describe('facade delegation', () => {
    it('should have all public methods available', () => {
      // Verify all domain methods exist on the facade
      expect(typeof service.navigateToProfile).toBe('function');
      expect(typeof service.verifyProfilePage).toBe('function');
      expect(typeof service.sendMessage).toBe('function');
      expect(typeof service.navigateToMessaging).toBe('function');
      expect(typeof service.composeAndSendMessage).toBe('function');
      expect(typeof service.executeMessagingWorkflow).toBe('function');
      expect(typeof service.sendConnectionRequest).toBe('function');
      expect(typeof service.checkConnectionStatus).toBe('function');
      expect(typeof service.executeConnectionWorkflow).toBe('function');
      expect(typeof service.createPost).toBe('function');
      expect(typeof service.publishPost).toBe('function');
      expect(typeof service.executePostCreationWorkflow).toBe('function');
      expect(typeof service.followProfile).toBe('function');
      expect(typeof service.checkFollowStatus).toBe('function');
      expect(typeof service.clickFollowButton).toBe('function');
      expect(typeof service.validateWorkflowParameters).toBe('function');
    });
  });

  describe('Typed DI contracts (ADR-D)', () => {
    it('accepts a hand-rolled contract-compliant fake for sessionManager and configManager', () => {
      const fakeSession = {
        getInstance: vi.fn(async () => ({})),
        cleanup: vi.fn(async () => {}),
        isSessionHealthy: vi.fn(async () => true),
        getHealthStatus: vi.fn(async () => ({})),
        recordError: vi.fn(async () => {}),
        getBackoffController: vi.fn(() => null),
        getSessionMetrics: vi.fn(() => null),
        lastActivity: null,
      };
      const fakeConfig = {
        get: vi.fn((_k: string, def: number) => def),
        setOverride: vi.fn(),
        getErrorHandlingConfig: vi.fn(() => ({ retryAttempts: 2, retryBaseDelay: 500 })),
      };

      const service = new LinkedInInteractionService({
        sessionManager: fakeSession,
        configManager: fakeConfig,
      });

      expect(service.maxRetries).toBe(2);
      expect(service.baseRetryDelay).toBe(500);
      expect(service.sessionManager).toBe(fakeSession);
      expect(service.configManager).toBe(fakeConfig);
    });
  });
});
