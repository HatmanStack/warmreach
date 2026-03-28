import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sendMessage,
  executeMessagingWorkflow,
  typeWithHumanPattern,
} from './linkedinMessagingOps.js';

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

describe('linkedinMessagingOps', () => {
  let mockService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockService = {
      _enforceRateLimit: vi.fn(),
      _applyControlPlaneRateLimits: vi.fn().mockResolvedValue(undefined),
      _reportInteraction: vi.fn(),
      checkSuspiciousActivity: vi.fn().mockResolvedValue({ isSuspicious: false }),
      getBrowserSession: vi.fn().mockResolvedValue({
        getPage: () => ({
          keyboard: { type: vi.fn(), press: vi.fn(), down: vi.fn(), up: vi.fn() },
        }),
      }),
      navigateToProfile: vi.fn().mockResolvedValue(true),
      navigateToMessaging: vi.fn().mockResolvedValue(undefined),
      composeAndSendMessage: vi.fn().mockResolvedValue({
        messageId: 'msg_123',
        deliveryStatus: 'sent',
      }),
      waitForMessagingInterface: vi.fn().mockResolvedValue(undefined),
      waitForMessageSent: vi.fn().mockResolvedValue(undefined),
      _scrapeAndStoreConversation: vi.fn().mockResolvedValue(undefined),
      sessionManager: {
        lastActivity: null,
        getSessionMetrics: vi.fn().mockReturnValue({ recordOperation: vi.fn() }),
      },
      humanBehavior: {
        recordAction: vi.fn(),
        simulateHumanMouseMovement: vi.fn(),
      },
      messageScraperService: {
        scrapeConversationThread: vi.fn().mockResolvedValue([]),
      },
      dynamoDBService: {
        updateMessages: vi.fn(),
      },
    };
  });

  describe('sendMessage', () => {
    it('should execute full send flow and return result', async () => {
      const result = await sendMessage(mockService, 'profile-1', 'Hello!', 'user-1');

      expect(mockService._enforceRateLimit).toHaveBeenCalled();
      expect(mockService.navigateToProfile).toHaveBeenCalledWith('profile-1');
      expect(mockService.navigateToMessaging).toHaveBeenCalledWith('profile-1');
      expect(mockService.composeAndSendMessage).toHaveBeenCalledWith('Hello!');
      expect(result.deliveryStatus).toBe('sent');
      expect(result.recipientProfileId).toBe('profile-1');
    });

    it('should throw on navigation failure', async () => {
      mockService.navigateToProfile.mockResolvedValue(false);
      await expect(sendMessage(mockService, 'p1', 'hi', 'u1')).rejects.toThrow(
        'Failed to navigate to profile'
      );
    });
  });

  describe('executeMessagingWorkflow', () => {
    it('should run complete workflow and track metrics', async () => {
      const result = await executeMessagingWorkflow(mockService, 'profile-1', 'Test message');

      expect(result.recipientProfileId).toBe('profile-1');
      expect(result.workflowSteps).toHaveLength(4);
      expect(mockService._reportInteraction).toHaveBeenCalledWith('executeMessagingWorkflow');
    });
  });

  describe('typeWithHumanPattern', () => {
    it('should type on element when provided', async () => {
      const mockElement = { type: vi.fn() };
      await typeWithHumanPattern(mockService, 'hello', mockElement);
      expect(mockElement.type).toHaveBeenCalledWith('hello');
    });

    it('should type via keyboard when no element', async () => {
      const mockPage = {
        keyboard: { type: vi.fn() },
      };
      mockService.getBrowserSession.mockResolvedValue({ getPage: () => mockPage });
      await typeWithHumanPattern(mockService, 'hello');
      expect(mockPage.keyboard.type).toHaveBeenCalledWith('hello');
    });
  });
});
