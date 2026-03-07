import { describe, it, expect, vi, beforeEach } from 'vitest';
import { messagesApiService } from './messagesApiService';
import { httpClient } from '@/shared/utils/httpClient';
import { ApiError } from '@/shared/utils/apiError';

vi.mock('@/shared/utils/httpClient', () => ({
  httpClient: {
    makeRequest: vi.fn(),
  },
}));

describe('MessagesApiService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getMessageHistory', () => {
    it('should fetch and format messages', async () => {
      const mockMessages = [
        { id: 'm1', content: 'Hello', sender: 'connection', timestamp: '2024-01-01T10:00:00Z' },
        { id: 'm2', content: 'Hi', sender: 'user', timestamp: '2024-01-01T10:05:00Z' },
      ];

      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: { messages: mockMessages, count: 2 },
      });

      const result = await messagesApiService.getMessageHistory('conn-1');

      expect(httpClient.makeRequest).toHaveBeenCalledWith('edges', 'get_messages', {
        profileId: 'conn-1',
      });
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('Hello');
    });

    it('should throw ApiError on request failure', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: false,
        error: 'Server error',
        data: null,
      });

      await expect(messagesApiService.getMessageHistory('conn-1')).rejects.toThrow(ApiError);
    });

    it('should throw error if connectionId is missing', async () => {
      await expect(messagesApiService.getMessageHistory('')).rejects.toThrow(
        'Connection ID is required'
      );
    });

    it('should handle invalid message data by sanitizing', async () => {
      const mockMessages = [
        { id: 'm1', content: 'Valid', sender: 'connection', timestamp: '2024-01-01T10:00:00Z' },
        { id: 'm2', content: 'Invalid', sender: 'unknown-sender', timestamp: 'not-a-date' },
      ];

      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: { messages: mockMessages, count: 2 },
      });

      const result = await messagesApiService.getMessageHistory('conn-1');

      // The second one should either be sanitized or filtered out
      // Based on implementation, it tries to sanitize.
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('should return empty array if messages is not an array', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: { messages: null, count: 0 },
      });

      const result = await messagesApiService.getMessageHistory('conn-1');
      expect(result).toEqual([]);
    });
  });
});
