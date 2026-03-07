import { describe, it, expect, vi, beforeEach } from 'vitest';
import { messageGenerationService } from './messageGenerationService';
import { CognitoAuthService } from '@/features/auth';
import { http, HttpResponse } from 'msw';
import { server } from '@/test-utils';

// Mock Cognito
vi.mock('@/features/auth', () => ({
  CognitoAuthService: {
    getCurrentUserToken: vi.fn().mockResolvedValue('mock-token'),
  },
}));

// Mock the whole config to ensure MOCK_MODE is false
vi.mock('@/config/appConfig', async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    API_CONFIG: {
      ...actual.API_CONFIG,
      BASE_URL: 'https://api.test',
      ENDPOINTS: {
        ...actual.API_CONFIG.ENDPOINTS,
        MESSAGE_GENERATION: '/generate',
      },
    },
  };
});

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
      server.use(
        http.post('https://api.test/generate', () => {
          return HttpResponse.json({ generatedMessage: 'Hello John' });
        })
      );

      const result = await messageGenerationService.generateMessage(validRequest);

      expect(result).toBe('Hello John');
    });

    it('should throw error on API failure', async () => {
      server.use(
        http.post('https://api.test/generate', () => {
          return new HttpResponse(JSON.stringify({ message: 'AI failed' }), { status: 500 });
        })
      );

      await expect(messageGenerationService.generateMessage(validRequest)).rejects.toThrow(
        'AI failed'
      );
    });

    it('should handle network error', async () => {
      server.use(
        http.post('https://api.test/generate', () => {
          return HttpResponse.error();
        })
      );

      await expect(messageGenerationService.generateMessage(validRequest)).rejects.toThrow(
        'Failed to fetch'
      );
    });

    it('should handle auth token retrieval failure', async () => {
      vi.mocked(CognitoAuthService.getCurrentUserToken).mockRejectedValueOnce(
        new Error('Auth failed')
      );

      server.use(
        http.post('https://api.test/generate', () => {
          return HttpResponse.json({ generatedMessage: 'Success without token' });
        })
      );

      const result = await messageGenerationService.generateMessage(validRequest);
      expect(result).toBe('Success without token');
    });
  });

  describe('generateBatchMessages', () => {
    it('should generate multiple messages', async () => {
      server.use(
        http.post('https://api.test/generate', () => {
          return HttpResponse.json({ generatedMessage: 'Done' });
        })
      );

      const results = await messageGenerationService.generateBatchMessages([
        validRequest,
        { ...validRequest, connectionId: 'c2' },
      ]);

      expect(results.size).toBe(2);
      expect(results.get('c1')).toBe('Done');
      expect(results.get('c2')).toBe('Done');
    });

    it('should throw if all messages fail', async () => {
      server.use(
        http.post('https://api.test/generate', () => {
          return new HttpResponse(JSON.stringify({ message: 'Fail' }), { status: 500 });
        })
      );

      await expect(messageGenerationService.generateBatchMessages([validRequest])).rejects.toThrow(
        'Batch generation failed'
      );
    });

    it('should handle partial batch failure', async () => {
      let callCount = 0;
      server.use(
        http.post('https://api.test/generate', () => {
          callCount++;
          if (callCount === 1) {
            return HttpResponse.json({ generatedMessage: 'Success' });
          }
          return new HttpResponse(null, { status: 500 });
        })
      );

      const results = await messageGenerationService.generateBatchMessages([
        validRequest,
        { ...validRequest, connectionId: 'c2' },
      ]);

      expect(results.size).toBe(1);
      expect(results.get('c1')).toBe('Success');
      expect(results.has('c2')).toBe(false);
    });

    it('should return empty map for empty requests', async () => {
      const results = await messageGenerationService.generateBatchMessages([]);
      expect(results.size).toBe(0);
    });
  });

  describe('error handling edge cases', () => {
    it('should handle non-JSON error response', async () => {
      server.use(
        http.post('https://api.test/generate', () => {
          return new HttpResponse('Plain text error', { status: 400 });
        })
      );

      await expect(messageGenerationService.generateMessage(validRequest)).rejects.toThrow(
        'HTTP error! status: 400'
      );
    });

    it('should handle malformed error JSON', async () => {
      server.use(
        http.post('https://api.test/generate', () => {
          return new HttpResponse('{invalid}', {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        })
      );

      await expect(messageGenerationService.generateMessage(validRequest)).rejects.toThrow(
        'HTTP error! status: 400'
      );
    });
  });
});
