import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LinkedInMessagingService } from './linkedinMessagingService.js';
import { buildPuppeteerPage } from '../../../test-utils/index.ts';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// Mock linkedinResolver
const { mockResolver } = vi.hoisted(() => ({
  mockResolver: {
    resolve: vi.fn(),
    resolveWithWait: vi.fn(),
  },
}));

vi.mock('../../linkedin/selectors/index.js', () => ({
  linkedinResolver: mockResolver,
}));

describe('LinkedInMessagingService', () => {
  let service;
  let mockSessionManager;
  let mockNavigationService;
  let mockDynamoDBService;
  let mockPage;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPage = buildPuppeteerPage();
    mockSessionManager = {
      getInstance: vi.fn().mockResolvedValue({
        getPage: () => mockPage,
      }),
    };
    mockNavigationService = {
      navigateToProfile: vi.fn().mockResolvedValue(undefined),
    };
    mockDynamoDBService = {
      upsertEdge: vi.fn().mockResolvedValue(true),
    };

    service = new LinkedInMessagingService({
      sessionManager: mockSessionManager,
      navigationService: mockNavigationService,
      dynamoDBService: mockDynamoDBService,
    });
  });

  describe('constructor', () => {
    it('should throw error if sessionManager is missing', () => {
      expect(() => new LinkedInMessagingService({})).toThrow(
        'LinkedInMessagingService requires sessionManager'
      );
    });
  });

  describe('sendMessage', () => {
    it('should send message successfully', async () => {
      const mockButton = { click: vi.fn(), type: vi.fn() };
      mockResolver.resolveWithWait.mockResolvedValue(mockButton);
      mockResolver.resolve.mockResolvedValue(true); // sent confirmation

      const result = await service.sendMessage('recipient-id', 'Hello!', 'user-123');

      expect(result.deliveryStatus).toBe('sent');
      expect(mockNavigationService.navigateToProfile).toHaveBeenCalledWith('recipient-id');
      expect(mockButton.type).toHaveBeenCalledWith('Hello!', expect.any(Object));
      expect(mockDynamoDBService.upsertEdge).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          targetProfileId: 'recipient-id',
          edgeType: 'message',
        })
      );
    });

    it('should handle message send failure (no confirmation)', async () => {
      const mockButton = { click: vi.fn(), type: vi.fn() };
      mockResolver.resolveWithWait.mockResolvedValue(mockButton);
      mockResolver.resolve.mockResolvedValue(false); // no sent confirmation

      const result = await service.sendMessage('recipient-id', 'Hello!', 'user-123');

      expect(result.deliveryStatus).toBe('pending');
    });

    it('should throw error and set failed status on navigation failure', async () => {
      mockNavigationService.navigateToProfile.mockRejectedValue(new Error('Navigation failed'));

      await expect(service.sendMessage('recipient-id', 'Hello!', 'user-123')).rejects.toThrow(
        'Navigation failed'
      );
    });
  });

  describe('navigateToMessaging', () => {
    it('should click message button and wait for input', async () => {
      const mockButton = { click: vi.fn() };
      mockResolver.resolveWithWait.mockResolvedValue(mockButton);

      await service.navigateToMessaging();

      expect(mockResolver.resolveWithWait).toHaveBeenCalledWith(
        mockPage,
        'messaging:message-button',
        expect.any(Object)
      );
      expect(mockButton.click).toHaveBeenCalled();
      expect(mockResolver.resolveWithWait).toHaveBeenCalledWith(
        mockPage,
        'messaging:message-input',
        expect.any(Object)
      );
    });
  });

  describe('composeAndSendMessage', () => {
    it('should type message and click send', async () => {
      const mockInput = { click: vi.fn(), type: vi.fn() };
      const mockSend = { click: vi.fn() };

      mockResolver.resolveWithWait.mockImplementation((page, selector) => {
        if (selector === 'messaging:message-input') return Promise.resolve(mockInput);
        if (selector === 'messaging:send-button') return Promise.resolve(mockSend);
        return Promise.resolve(null);
      });

      await service.composeAndSendMessage('Test message');

      expect(mockInput.click).toHaveBeenCalled();
      expect(mockInput.type).toHaveBeenCalledWith('Test message', expect.any(Object));
      expect(mockSend.click).toHaveBeenCalled();
    });
  });

  describe('waitForMessageSent', () => {
    it('should return true if sent confirmation found', async () => {
      mockResolver.resolve.mockResolvedValue(true);
      const result = await service.waitForMessageSent();
      expect(result).toBe(true);
    });

    it('should return false if sent confirmation not found', async () => {
      mockResolver.resolve.mockResolvedValue(false);
      const result = await service.waitForMessageSent();
      expect(result).toBe(false);
    });
  });
});
