/**
 * Unit tests for RAGStack Search Service
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test-utils';
import { CognitoAuthService } from '@/features/auth';

// Mock Cognito auth service
vi.mock('@/features/auth', () => ({
  CognitoAuthService: {
    getCurrentUserToken: vi.fn().mockResolvedValue('mock-jwt-token'),
  },
}));

// Import after mocks are set up
import { searchProfiles, SearchError } from './ragstackSearchService';

describe('ragstackSearchService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('searchProfiles', () => {
    it('should return profile IDs from search', async () => {
      server.use(
        http.post('*/ragstack', () => {
          return HttpResponse.json({
            statusCode: 200,
            body: JSON.stringify({
              results: [
                { source: 'profile_abc123', score: 0.95, content: 'John Doe software engineer' },
                { source: 'profile_def456', score: 0.85, content: 'Jane Smith product manager' },
              ],
              totalResults: 2,
            }),
          });
        })
      );

      const response = await searchProfiles('software engineer');

      expect(response.results).toHaveLength(2);
      expect(response.results[0].profileId).toBe('abc123');
      expect(response.results[1].profileId).toBe('def456');
    });

    it('should handle direct API response format', async () => {
      server.use(
        http.post('*/ragstack', () => {
          return HttpResponse.json({
            results: [{ source: 'profile_xyz789', score: 0.9, content: 'Test content' }],
            totalResults: 1,
          });
        })
      );

      const response = await searchProfiles('test query');

      expect(response.results).toHaveLength(1);
      expect(response.results[0].profileId).toBe('xyz789');
      expect(response.results[0].score).toBe(0.9);
    });

    it('should handle empty results', async () => {
      server.use(
        http.post('*/ragstack', () => {
          return HttpResponse.json({
            results: [],
            totalResults: 0,
          });
        })
      );

      const response = await searchProfiles('nonexistent person');

      expect(response.results).toEqual([]);
      expect(response.totalResults).toBe(0);
    });

    it('should pass maxResults parameter', async () => {
      let capturedBody: Record<string, unknown> = {};
      server.use(
        http.post('*/ragstack', async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ results: [], totalResults: 0 });
        })
      );

      await searchProfiles('test', 50);
      expect(capturedBody.maxResults).toBe(50);
    });

    it('should use default maxResults of 100', async () => {
      let capturedBody: Record<string, unknown> = {};
      server.use(
        http.post('*/ragstack', async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ results: [], totalResults: 0 });
        })
      );

      await searchProfiles('test');
      expect(capturedBody.maxResults).toBe(100);
    });

    it('should throw SearchError on network error', async () => {
      server.use(
        http.post('*/ragstack', () => {
          return HttpResponse.error();
        })
      );

      await expect(searchProfiles('test')).rejects.toThrow(SearchError);
    });

    it('should throw SearchError on HTTP error from lambda proxy', async () => {
      server.use(
        http.post('*/ragstack', () => {
          return HttpResponse.json({
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal server error' }),
          });
        })
      );

      await expect(searchProfiles('test')).rejects.toThrow(SearchError);
    });

    it('should extract snippet from content', async () => {
      server.use(
        http.post('*/ragstack', () => {
          return HttpResponse.json({
            results: [{ source: 'profile_abc', score: 0.9, content: 'This is a test snippet' }],
            totalResults: 1,
          });
        })
      );

      const response = await searchProfiles('test');
      expect(response.results[0].snippet).toContain('test snippet');
    });

    it('should handle malformed source field gracefully', async () => {
      server.use(
        http.post('*/ragstack', () => {
          return HttpResponse.json({
            results: [{ source: 'malformed', score: 0.9, content: 'Content' }],
            totalResults: 1,
          });
        })
      );

      const response = await searchProfiles('test');
      expect(response.results[0].profileId).toBe('malformed');
    });

    it('should return empty results for empty query', async () => {
      const response = await searchProfiles('');
      expect(response.results).toEqual([]);
    });

    it('should handle lambda response with object body', async () => {
      server.use(
        http.post('*/ragstack', () => {
          return HttpResponse.json({
            statusCode: 200,
            body: {
              results: [{ source: 'p1', score: 0.8, content: 'Object body' }],
              totalResults: 1,
            },
          });
        })
      );

      const response = await searchProfiles('test');
      expect(response.results[0].profileId).toBe('p1');
    });

    it('should handle auth token retrieval failure', async () => {
      vi.mocked(CognitoAuthService.getCurrentUserToken).mockRejectedValueOnce(
        new Error('Auth failed')
      );

      server.use(
        http.post('*/ragstack', () => {
          return HttpResponse.json({ results: [], totalResults: 0 });
        })
      );

      const response = await searchProfiles('test');
      expect(response.results).toEqual([]);
    });

    it('should throw SearchError on non-ok HTTP response', async () => {
      server.use(
        http.post('*/ragstack', () => {
          return new HttpResponse(null, { status: 401 });
        })
      );

      await expect(searchProfiles('test')).rejects.toThrow(SearchError);
    });

    it('should correctly determine retryability', () => {
      const e1 = new SearchError('fail', { status: 500 });
      expect(e1.retryable).toBe(true);

      const e2 = new SearchError('fail', { status: 400 });
      expect(e2.retryable).toBe(false);

      const e3 = new SearchError('fail', { status: 429 });
      expect(e3.retryable).toBe(true);

      const e4 = new SearchError('fail'); // network
      expect(e4.retryable).toBe(true);
    });

    it('should handle malformed error body from lambda proxy', async () => {
      server.use(
        http.post('*/ragstack', () => {
          return HttpResponse.json({
            statusCode: 500,
            body: 'invalid-json',
          });
        })
      );

      await expect(searchProfiles('test')).rejects.toThrow(/Unexpected token/);
    });
  });
});
