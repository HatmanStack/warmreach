import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InteractionMessagingService } from './interactionMessagingService.js';
import { BrowserSessionManager } from '../../session/services/browserSessionManager.js';
import { buildPuppeteerPage } from '../../../test-utils/index.ts';

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
  },
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
  default: { linkedin: { baseUrl: 'https://www.linkedin.com' } },
}));

describe('InteractionMessagingService', () => {
  let service;
  let mockPage;
  let mockNavService;
  let mockScraperService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPage = buildPuppeteerPage();
    const mockSession = {
      getPage: () => mockPage,
      goto: vi.fn().mockResolvedValue({ ok: () => true }),
      waitForSelector: vi.fn().mockResolvedValue({}),
    };
    BrowserSessionManager.getInstance.mockResolvedValue(mockSession);

    mockNavService = {
      navigateToProfile: vi.fn().mockResolvedValue(true),
    };

    mockScraperService = {
      scrapeConversationThread: vi.fn().mockResolvedValue([]),
    };

    service = new InteractionMessagingService({
      interactionNavigationService: mockNavService,
      messageScraperService: mockScraperService,
    });
  });

  describe('sendMessage', () => {
    it('should execute full messaging flow', async () => {
      vi.spyOn(service, 'navigateToMessaging').mockResolvedValue(undefined);
      vi.spyOn(service, 'composeAndSendMessage').mockResolvedValue({ messageId: 'm1' });

      const result = await service.sendMessage('p1', 'hello', 'u1');

      expect(result.messageId).toBe('m1');
      expect(result.deliveryStatus).toBe('sent');
      expect(mockNavService.navigateToProfile).toHaveBeenCalledWith('p1');
    });

    it('should throw when navigation fails', async () => {
      mockNavService.navigateToProfile.mockResolvedValue(false);

      await expect(service.sendMessage('p1', 'hello', 'u1')).rejects.toThrow(
        'Failed to navigate to profile'
      );
    });
  });

  describe('executeMessagingWorkflow', () => {
    it('should execute workflow and record metrics', async () => {
      vi.spyOn(service, 'navigateToMessaging').mockResolvedValue(undefined);
      vi.spyOn(service, 'composeAndSendMessage').mockResolvedValue({
        messageId: 'm1',
        deliveryStatus: 'sent',
      });

      const result = await service.executeMessagingWorkflow('p1', 'hello');

      expect(result.messageId).toBe('m1');
      expect(result.workflowSteps).toHaveLength(4);
    });
  });

  describe('waitForMessagingInterface', () => {
    it('should succeed when messaging input found', async () => {
      mockResolver.resolveWithWait.mockResolvedValue({});
      await expect(service.waitForMessagingInterface()).resolves.not.toThrow();
    });

    it('should throw when messaging input not found', async () => {
      mockResolver.resolveWithWait.mockResolvedValue(null);
      await expect(service.waitForMessagingInterface()).rejects.toThrow(
        'Messaging interface did not load'
      );
    });
  });

  describe('_scrapeAndStoreConversation', () => {
    it('should scrape and store messages when available', async () => {
      mockScraperService.scrapeConversationThread.mockResolvedValue([{ text: 'hi' }]);

      await service._scrapeAndStoreConversation('p1');

      expect(mockScraperService.scrapeConversationThread).toHaveBeenCalledWith('p1');
      expect(service.dynamoDBService.updateMessages).toHaveBeenCalledWith('p1', [{ text: 'hi' }]);
    });

    it('should handle scraper errors gracefully', async () => {
      mockScraperService.scrapeConversationThread.mockRejectedValue(new Error('failed'));

      await expect(service._scrapeAndStoreConversation('p1')).resolves.not.toThrow();
    });
  });
});
