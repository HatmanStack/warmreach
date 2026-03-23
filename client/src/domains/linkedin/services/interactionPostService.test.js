import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InteractionPostService } from './interactionPostService.js';
import { BrowserSessionManager } from '../../session/services/browserSessionManager.js';
import { buildPuppeteerPage } from '../../../test-utils/index.ts';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../storage/services/dynamoDBService.js', () => ({
  default: vi.fn().mockImplementation(function () {
    return { setAuthToken: vi.fn() };
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

describe('InteractionPostService', () => {
  let service;
  let mockPage;
  let mockSession;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPage = buildPuppeteerPage();
    mockSession = {
      getPage: () => mockPage,
      goto: vi.fn().mockResolvedValue({ ok: () => true }),
      waitForSelector: vi.fn().mockResolvedValue({}),
    };
    BrowserSessionManager.getInstance.mockResolvedValue(mockSession);

    service = new InteractionPostService();
  });

  describe('createPost', () => {
    it('should execute full post creation flow', async () => {
      vi.spyOn(service, 'navigateToPostCreator').mockResolvedValue(undefined);
      vi.spyOn(service, 'composePost').mockResolvedValue(undefined);
      vi.spyOn(service, 'publishPost').mockResolvedValue({
        postId: 'post1',
        postUrl: 'https://linkedin.com/posts/1',
        status: 'published',
      });

      const result = await service.createPost('Test post', [], 'u1');

      expect(result.postId).toBe('post1');
      expect(result.publishStatus).toBe('published');
    });
  });

  describe('publishPost', () => {
    it('should publish when button is found and enabled', async () => {
      const mockButton = {
        getAttribute: vi.fn().mockResolvedValue(null),
        click: vi.fn(),
      };
      mockResolver.resolveWithWait.mockResolvedValue(mockButton);

      const result = await service.publishPost();

      expect(result.postId).toBeDefined();
      expect(result.status).toBe('published');
    });

    it('should throw when publish button not found', async () => {
      mockResolver.resolveWithWait.mockResolvedValue(null);

      await expect(service.publishPost()).rejects.toThrow('Publish button not found');
    });
  });

  describe('executePostCreationWorkflow', () => {
    it('should execute workflow and record metrics', async () => {
      vi.spyOn(service, 'navigateToPostCreator').mockResolvedValue(undefined);
      vi.spyOn(service, 'composePost').mockResolvedValue(undefined);
      vi.spyOn(service, 'publishPost').mockResolvedValue({
        postId: 'post1',
        postUrl: 'https://linkedin.com/posts/1',
        status: 'published',
        publishedAt: new Date().toISOString(),
      });

      const result = await service.executePostCreationWorkflow('Test content');

      expect(result.postId).toBe('post1');
      expect(result.workflowSteps).toHaveLength(5);
    });
  });

  describe('waitForPostCreationInterface', () => {
    it('should succeed when editor found', async () => {
      mockResolver.resolveWithWait.mockResolvedValue({});
      await expect(service.waitForPostCreationInterface()).resolves.not.toThrow();
    });

    it('should throw when editor not found', async () => {
      mockResolver.resolveWithWait.mockResolvedValue(null);
      await expect(service.waitForPostCreationInterface()).rejects.toThrow(
        'Post creation interface did not load'
      );
    });
  });
});
