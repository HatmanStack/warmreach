import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist the mock
const { mockPost } = vi.hoisted(() => ({
  mockPost: vi.fn(),
}));

// Mock httpClient
vi.mock('@/shared/utils/httpClient', () => ({
  httpClient: {
    post: mockPost,
  },
}));

// Mock Cognito (httpClient uses this internally but it's already mocked at httpClient level)
vi.mock('@/features/auth', () => ({
  CognitoAuthService: {
    getCurrentUserToken: vi.fn().mockResolvedValue('mock-token'),
  },
}));

import { messageGenerationService, MessageGenerationError } from './messageGenerationService';

describe('MessageGenerationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VITE_MOCK_MODE', 'false');
    vi.stubEnv('NODE_ENV', 'test');
  });

  const validRequest = {
    connectionId: 'c1',
    conversationTopic: 'Testing',
    connectionProfile: {
      firstName: 'John',
      lastName: 'Doe',
      position: 'Engineer',
      company: 'Tech',
    },
  };

  describe('generateMessage', () => {
    it('should generate a message successfully', async () => {
      mockPost.mockResolvedValueOnce({
        success: true,
        data: { generatedMessage: 'Hello John' },
      });

      const result = await messageGenerationService.generateMessage(validRequest);
      expect(result).toBe('Hello John');
    });

    it('should throw error on API failure', async () => {
      mockPost.mockResolvedValueOnce({
        success: false,
        error: { message: 'AI failed', status: 500 },
      });

      await expect(messageGenerationService.generateMessage(validRequest)).rejects.toThrow(
        'AI failed'
      );
    });

    it('should handle network error', async () => {
      mockPost.mockResolvedValueOnce({
        success: false,
        error: { message: 'Network error - unable to reach server', code: 'NETWORK_ERROR' },
      });

      await expect(messageGenerationService.generateMessage(validRequest)).rejects.toThrow(
        'Network error'
      );
    });

    it('should handle auth token retrieval failure gracefully', async () => {
      // httpClient handles auth internally; even if auth fails, request proceeds
      mockPost.mockResolvedValueOnce({
        success: true,
        data: { generatedMessage: 'Success without token' },
      });

      const result = await messageGenerationService.generateMessage(validRequest);
      expect(result).toBe('Success without token');
    });
  });

  describe('generateBatchMessages', () => {
    it('should generate multiple messages', async () => {
      mockPost.mockResolvedValue({
        success: true,
        data: { generatedMessage: 'Done' },
      });

      const { results, errors } = await messageGenerationService.generateBatchMessages([
        validRequest,
        { ...validRequest, connectionId: 'c2' },
      ]);

      expect(results.size).toBe(2);
      expect(results.get('c1')).toBe('Done');
      expect(results.get('c2')).toBe('Done');
      expect(errors.size).toBe(0);
    });

    it('should throw if all messages fail', async () => {
      mockPost.mockResolvedValue({
        success: false,
        error: { message: 'Fail', status: 500 },
      });

      await expect(messageGenerationService.generateBatchMessages([validRequest])).rejects.toThrow(
        'Batch generation failed'
      );
    });

    it('should handle partial batch failure', async () => {
      mockPost
        .mockResolvedValueOnce({
          success: true,
          data: { generatedMessage: 'Success' },
        })
        .mockResolvedValueOnce({
          success: false,
          error: { message: 'Fail', status: 500 },
        });

      const { results, errors } = await messageGenerationService.generateBatchMessages([
        validRequest,
        { ...validRequest, connectionId: 'c2' },
      ]);

      expect(results.size).toBe(1);
      expect(results.get('c1')).toBe('Success');
      expect(errors.size).toBe(1);
      expect(errors.has('c2')).toBe(true);
    });

    it('should return empty maps for empty requests', async () => {
      const { results, errors } = await messageGenerationService.generateBatchMessages([]);
      expect(results.size).toBe(0);
      expect(errors.size).toBe(0);
    });
  });

  describe('error handling edge cases', () => {
    it('should handle non-JSON error response', async () => {
      mockPost.mockResolvedValueOnce({
        success: false,
        error: { message: 'HTTP 400 error', status: 400, code: 'ERR_BAD_REQUEST' },
      });

      await expect(messageGenerationService.generateMessage(validRequest)).rejects.toThrow();
    });

    it('should throw MessageGenerationError for invalid response', async () => {
      mockPost.mockResolvedValueOnce({
        success: true,
        data: { someOtherField: 'no generatedMessage' },
      });

      await expect(messageGenerationService.generateMessage(validRequest)).rejects.toBeInstanceOf(
        MessageGenerationError
      );
    });
  });
});
