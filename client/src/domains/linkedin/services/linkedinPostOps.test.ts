import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPost, publishPost, executePostCreationWorkflow } from './linkedinPostOps.js';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('#shared-config/index.js', () => ({
  default: { linkedin: { baseUrl: 'https://www.linkedin.com' } },
}));

const { mockResolver } = vi.hoisted(() => ({
  mockResolver: {
    resolve: vi.fn(),
    resolveWithWait: vi.fn(),
  },
}));

vi.mock('../selectors/index.js', () => ({
  linkedinResolver: mockResolver,
}));

vi.mock('../utils/LinkedInError.js', () => ({
  LinkedInError: class extends Error {
    constructor(msg, code) {
      super(msg);
      this.code = code;
    }
  },
}));

describe('linkedinPostOps', () => {
  let mockService;
  let mockPage;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPage = {
      url: vi.fn().mockReturnValue('https://www.linkedin.com/feed/'),
      keyboard: { down: vi.fn(), up: vi.fn(), press: vi.fn(), type: vi.fn() },
    };
    const mockSession = {
      getPage: () => mockPage,
      goto: vi.fn().mockResolvedValue({}),
      waitForSelector: vi.fn().mockResolvedValue({}),
    };

    mockService = {
      _enforceRateLimit: vi.fn(),
      _applyControlPlaneRateLimits: vi.fn().mockResolvedValue(undefined),
      _reportInteraction: vi.fn(),
      _paced: vi.fn((min, max, fn) => fn()),
      checkSuspiciousActivity: vi.fn().mockResolvedValue({ isSuspicious: false }),
      getBrowserSession: vi.fn().mockResolvedValue(mockSession),
      navigateToPostCreator: vi.fn().mockResolvedValue(undefined),
      composePost: vi.fn().mockResolvedValue(undefined),
      addMediaAttachments: vi.fn().mockResolvedValue(undefined),
      publishPost: vi.fn().mockResolvedValue({
        postId: 'post_123',
        postUrl: 'https://linkedin.com/posts/123',
        status: 'published',
        publishedAt: new Date().toISOString(),
      }),
      waitForLinkedInLoad: vi.fn().mockResolvedValue(undefined),
      waitForPostCreationInterface: vi.fn().mockResolvedValue(undefined),
      typeWithHumanPattern: vi.fn().mockResolvedValue(undefined),
      clearAndTypeText: vi.fn().mockResolvedValue(undefined),
      clickElementHumanly: vi.fn().mockResolvedValue(undefined),
      sessionManager: {
        lastActivity: null,
        getSessionMetrics: vi.fn().mockReturnValue({ recordOperation: vi.fn() }),
      },
      humanBehavior: {
        recordAction: vi.fn(),
        simulateHumanMouseMovement: vi.fn(),
        checkAndApplyCooldown: vi.fn(),
      },
    };
  });

  describe('createPost', () => {
    it('should execute full post creation flow', async () => {
      const result = await createPost(mockService, 'Test post content', [], 'user-1');

      expect(mockService._enforceRateLimit).toHaveBeenCalled();
      expect(mockService.navigateToPostCreator).toHaveBeenCalled();
      expect(mockService.composePost).toHaveBeenCalledWith('Test post content');
      expect(mockService.publishPost).toHaveBeenCalled();
      expect(result.publishStatus).toBe('published');
      expect(result.userId).toBe('user-1');
    });

    it('should add media attachments when provided', async () => {
      const media = [{ type: 'image', filename: 'test.jpg' }];
      await createPost(mockService, 'With media', media, 'user-1');
      expect(mockService.addMediaAttachments).toHaveBeenCalledWith(media);
    });
  });

  describe('publishPost', () => {
    it('should click publish button and return result', async () => {
      const mockPublishButton = {
        evaluate: vi.fn().mockResolvedValue(null),
      };
      mockResolver.resolveWithWait.mockResolvedValue(mockPublishButton);

      const result = await publishPost(mockService);

      expect(result.status).toBe('published');
      expect(result.postId).toBeDefined();
      expect(mockService.clickElementHumanly).toHaveBeenCalled();
    });

    it('should throw when publish button not found', async () => {
      mockResolver.resolveWithWait.mockRejectedValue(new Error('not found'));
      await expect(publishPost(mockService)).rejects.toThrow('Publish button not found');
    });
  });

  describe('executePostCreationWorkflow', () => {
    it('should run complete workflow', async () => {
      const result = await executePostCreationWorkflow(mockService, 'Test content', [], {});

      expect(result.publishStatus).toBe('published');
      expect(result.workflowSteps).toHaveLength(5);
      expect(mockService._reportInteraction).toHaveBeenCalledWith('executePostCreationWorkflow');
    });
  });
});
