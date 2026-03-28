import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { LinkedInMessageScraperService } from './linkedinMessageScraperService.js';

function createMockSessionManager() {
  return {
    getInstance: vi.fn().mockResolvedValue({
      getPage: () => ({
        url: vi.fn(() => 'https://www.linkedin.com/messaging/'),
        goto: vi.fn().mockResolvedValue(null),
        waitForSelector: vi.fn().mockResolvedValue({}),
        evaluate: vi.fn().mockResolvedValue([]),
      }),
    }),
  };
}

describe('LinkedInMessageScraperService', () => {
  let service;
  let mockSessionManager;

  beforeEach(() => {
    mockSessionManager = createMockSessionManager();
    service = new LinkedInMessageScraperService({ sessionManager: mockSessionManager });
    // Stub delays to avoid timeouts in tests
    service._delay = vi.fn().mockResolvedValue();
  });

  describe('constructor', () => {
    it('requires sessionManager', () => {
      expect(() => new LinkedInMessageScraperService()).toThrow(
        'LinkedInMessageScraperService requires sessionManager'
      );
    });

    it('accepts sessionManager', () => {
      const svc = new LinkedInMessageScraperService({ sessionManager: mockSessionManager });
      expect(svc.sessionManager).toBe(mockSessionManager);
    });
  });

  describe('scrapeAllConversations', () => {
    it('returns empty Map when no connection IDs provided', async () => {
      const result = await service.scrapeAllConversations([]);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it('returns empty Map when connectionProfileIds is null', async () => {
      const result = await service.scrapeAllConversations(null);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it('navigates to /messaging/ page', async () => {
      // Stub internal methods to isolate navigation test
      service._navigateToMessaging = vi.fn().mockResolvedValue();
      service._scrollConversationList = vi.fn().mockResolvedValue();
      service._extractConversationEntries = vi.fn().mockResolvedValue([]);

      await service.scrapeAllConversations(['john-doe']);

      expect(service._navigateToMessaging).toHaveBeenCalled();
    });

    it('filters conversations to matching connection IDs', async () => {
      service._navigateToMessaging = vi.fn().mockResolvedValue();
      service._scrollConversationList = vi.fn().mockResolvedValue();
      service._extractConversationEntries = vi.fn().mockResolvedValue([
        { profileId: 'john-doe', index: 0 },
        { profileId: 'jane-smith', index: 1 },
        { profileId: 'bob-wilson', index: 2 },
      ]);
      service._clickConversation = vi.fn().mockResolvedValue();
      service._scrollThreadUp = vi.fn().mockResolvedValue();
      service._extractMessages = vi
        .fn()
        .mockResolvedValue([
          { id: 'msg-1', content: 'Hello', timestamp: '2024-01-01T00:00:00', sender: 'outbound' },
        ]);

      const result = await service.scrapeAllConversations(['john-doe', 'bob-wilson']);

      expect(result).toBeInstanceOf(Map);
      expect(result.has('john-doe')).toBe(true);
      expect(result.has('bob-wilson')).toBe(true);
      expect(result.has('jane-smith')).toBe(false);
    });

    it('returns partial results when individual conversations fail', async () => {
      service._navigateToMessaging = vi.fn().mockResolvedValue();
      service._scrollConversationList = vi.fn().mockResolvedValue();
      service._extractConversationEntries = vi.fn().mockResolvedValue([
        { profileId: 'john-doe', index: 0 },
        { profileId: 'jane-smith', index: 1 },
      ]);
      service._clickConversation = vi.fn().mockResolvedValue();
      service._scrollThreadUp = vi.fn().mockResolvedValue();

      let callCount = 0;
      service._extractMessages = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([
            { id: 'msg-1', content: 'Hello', timestamp: '2024-01-01', sender: 'outbound' },
          ]);
        }
        return Promise.reject(new Error('Extraction failed'));
      });

      const result = await service.scrapeAllConversations(['john-doe', 'jane-smith']);

      expect(result).toBeInstanceOf(Map);
      expect(result.has('john-doe')).toBe(true);
      expect(result.get('john-doe')).toHaveLength(1);
    });

    it('respects maxConversations option', async () => {
      service._navigateToMessaging = vi.fn().mockResolvedValue();
      service._scrollConversationList = vi.fn().mockResolvedValue();
      service._extractConversationEntries = vi.fn().mockResolvedValue([
        { profileId: 'user-1', index: 0 },
        { profileId: 'user-2', index: 1 },
        { profileId: 'user-3', index: 2 },
      ]);
      service._clickConversation = vi.fn().mockResolvedValue();
      service._scrollThreadUp = vi.fn().mockResolvedValue();
      service._extractMessages = vi
        .fn()
        .mockResolvedValue([
          { id: 'msg-1', content: 'Hi', timestamp: '2024-01-01', sender: 'outbound' },
        ]);

      const result = await service.scrapeAllConversations(['user-1', 'user-2', 'user-3'], {
        maxConversations: 2,
      });

      expect(service._clickConversation).toHaveBeenCalledTimes(2);
      expect(result.size).toBeLessThanOrEqual(2);
    });
  });

  describe('scrapeConversationThread', () => {
    it('returns messages from open thread', async () => {
      const messages = [
        { id: 'msg-1', content: 'Hello', timestamp: '2024-01-01T00:00:00', sender: 'outbound' },
        { id: 'msg-2', content: 'Hi there', timestamp: '2024-01-01T00:01:00', sender: 'inbound' },
      ];

      service._extractConversationEntries = vi
        .fn()
        .mockResolvedValue([{ profileId: 'john-doe', index: 0 }]);
      service._clickConversation = vi.fn().mockResolvedValue();
      service._scrollThreadUp = vi.fn().mockResolvedValue();
      service._extractMessages = vi.fn().mockResolvedValue(messages);

      const result = await service.scrapeConversationThread('john-doe');

      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('Hello');
      expect(result[1].sender).toBe('inbound');
    });

    it('returns empty array on failure', async () => {
      service._extractConversationEntries = vi.fn().mockRejectedValue(new Error('Page crashed'));

      const result = await service.scrapeConversationThread('john-doe');

      expect(result).toEqual([]);
    });

    it('navigates to messaging if not already there', async () => {
      const mockPage = {
        url: vi.fn(() => 'https://www.linkedin.com/in/john-doe/'),
        goto: vi.fn().mockResolvedValue(null),
        waitForSelector: vi.fn().mockResolvedValue({}),
        evaluate: vi.fn().mockResolvedValue([]),
      };
      mockSessionManager.getInstance.mockResolvedValue({ getPage: () => mockPage });

      service._navigateToMessaging = vi.fn().mockResolvedValue();
      service._extractConversationEntries = vi.fn().mockResolvedValue([]);
      service._scrollThreadUp = vi.fn().mockResolvedValue();
      service._extractMessages = vi.fn().mockResolvedValue([]);

      await service.scrapeConversationThread('john-doe');

      expect(service._navigateToMessaging).toHaveBeenCalled();
    });
  });

  describe('message format', () => {
    it('returns messages with required fields', async () => {
      const messages = [
        {
          id: 'msg-123-0',
          content: 'Test message',
          timestamp: '2024-01-15T10:30:00.000Z',
          sender: 'outbound',
        },
      ];

      service._extractConversationEntries = vi
        .fn()
        .mockResolvedValue([{ profileId: 'john-doe', index: 0 }]);
      service._clickConversation = vi.fn().mockResolvedValue();
      service._scrollThreadUp = vi.fn().mockResolvedValue();
      service._extractMessages = vi.fn().mockResolvedValue(messages);

      const result = await service.scrapeConversationThread('john-doe');

      expect(result[0]).toHaveProperty('id');
      expect(result[0]).toHaveProperty('content');
      expect(result[0]).toHaveProperty('timestamp');
      expect(result[0]).toHaveProperty('sender');
      expect(['outbound', 'inbound']).toContain(result[0].sender);
    });
  });
});
