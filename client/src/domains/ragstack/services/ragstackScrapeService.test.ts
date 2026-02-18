import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RagstackScrapeService } from './ragstackScrapeService.js';
import {
  RagstackHttpError,
  RagstackGraphQLError,
  RagstackTimeoutError,
} from '../types/ragstack.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const testConfig = {
  endpoint: 'https://test.appsync-api.amazonaws.com/graphql',
  apiKey: 'test-api-key',
  scrape: {
    maxPages: 5,
    maxDepth: 1,
    scrapeMode: 'FULL' as const,
    scope: 'SUBPAGES' as const,
  },
  retry: {
    maxAttempts: 3,
    baseDelay: 10, // Short for tests
    maxDelay: 100,
  },
};

describe('RagstackScrapeService', () => {
  let service: RagstackScrapeService;

  beforeEach(() => {
    mockFetch.mockReset();
    service = new RagstackScrapeService(testConfig);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should throw if endpoint is missing', () => {
      expect(() => new RagstackScrapeService({ ...testConfig, endpoint: '' })).toThrow(/endpoint/i);
    });

    it('should throw if apiKey is missing', () => {
      expect(() => new RagstackScrapeService({ ...testConfig, apiKey: '' })).toThrow(/apiKey/i);
    });
  });

  describe('startScrape', () => {
    it('should start scrape job successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            startScrape: {
              jobId: 'job-123',
              baseUrl: 'https://www.linkedin.com/in/john-doe/',
              status: 'PENDING',
            },
          },
        }),
      });

      const result = await service.startScrape('john-doe', 'li_at=abc123');

      expect(result.jobId).toBe('job-123');
      expect(result.status).toBe('PENDING');

      // Verify request
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe(testConfig.endpoint);
      expect(options.headers['x-api-key']).toBe(testConfig.apiKey);
      expect(options.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(options.body);
      expect(body.variables.input.url).toBe('https://www.linkedin.com/in/john-doe/');
      expect(body.variables.input.cookies).toBe('li_at=abc123');
      expect(body.variables.input.maxPages).toBe(5);
      expect(body.variables.input.maxDepth).toBe(1);
      expect(body.variables.input.scope).toBe('SUBPAGES');
    });

    it('should throw RagstackHttpError on 401', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await expect(service.startScrape('john-doe', 'bad-cookie')).rejects.toThrow(
        RagstackHttpError
      );
    });

    it('should throw RagstackHttpError on 400', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      });

      await expect(service.startScrape('john-doe', 'cookie')).rejects.toThrow(RagstackHttpError);

      expect(mockFetch).toHaveBeenCalledTimes(1); // No retries on 4xx
    });

    it('should throw RagstackGraphQLError on GraphQL errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          errors: [{ message: 'Invalid input' }],
        }),
      });

      await expect(service.startScrape('john-doe', 'cookie')).rejects.toThrow(RagstackGraphQLError);
    });

    it('should retry on 5xx errors', async () => {
      // First two calls fail with 500, third succeeds
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Error' })
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Error' })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              startScrape: {
                jobId: 'job-123',
                baseUrl: 'https://www.linkedin.com/in/john-doe/',
                status: 'PENDING',
              },
            },
          }),
        });

      const result = await service.startScrape('john-doe', 'cookie');

      expect(result.jobId).toBe('job-123');
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should retry on 429 rate limit', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'Rate limited' })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              startScrape: {
                jobId: 'job-123',
                baseUrl: 'https://www.linkedin.com/in/john-doe/',
                status: 'PENDING',
              },
            },
          }),
        });

      const result = await service.startScrape('john-doe', 'cookie');

      expect(result.jobId).toBe('job-123');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should not retry on 400 errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      });

      await expect(service.startScrape('john-doe', 'cookie')).rejects.toThrow(RagstackHttpError);

      expect(mockFetch).toHaveBeenCalledTimes(1); // No retries
    });

    it('should fail after max retries exceeded', async () => {
      // All calls fail with 500
      mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'Error' });

      await expect(service.startScrape('john-doe', 'cookie')).rejects.toThrow(RagstackHttpError);

      expect(mockFetch).toHaveBeenCalledTimes(3); // maxAttempts
    });

    it('should retry on network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error')).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            startScrape: {
              jobId: 'job-123',
              baseUrl: 'https://www.linkedin.com/in/john-doe/',
              status: 'PENDING',
            },
          },
        }),
      });

      const result = await service.startScrape('john-doe', 'cookie');

      expect(result.jobId).toBe('job-123');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('getScrapeJob', () => {
    it('should return job status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            getScrapeJob: {
              job: {
                jobId: 'job-123',
                status: 'COMPLETED',
                processedCount: 3,
                totalUrls: 3,
              },
            },
          },
        }),
      });

      const result = await service.getScrapeJob('job-123');

      expect(result.status).toBe('COMPLETED');
      expect(result.processedCount).toBe(3);
      expect(result.jobId).toBe('job-123');
    });

    it('should include jobId in query', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            getScrapeJob: {
              job: {
                jobId: 'job-456',
                status: 'PROCESSING',
              },
            },
          },
        }),
      });

      await service.getScrapeJob('job-456');

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.variables.jobId).toBe('job-456');
    });
  });

  describe('waitForCompletion', () => {
    it('should poll until completed', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: { getScrapeJob: { job: { jobId: 'job-123', status: 'PENDING' } } },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: { getScrapeJob: { job: { jobId: 'job-123', status: 'PROCESSING' } } },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              getScrapeJob: { job: { jobId: 'job-123', status: 'COMPLETED', processedCount: 5 } },
            },
          }),
        });

      const result = await service.waitForCompletion('job-123', { pollInterval: 10 });

      expect(result.status).toBe('COMPLETED');
      expect(result.processedCount).toBe(5);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should return on FAILED status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { getScrapeJob: { job: { jobId: 'job-123', status: 'FAILED' } } },
        }),
      });

      const result = await service.waitForCompletion('job-123', { pollInterval: 10 });

      expect(result.status).toBe('FAILED');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should return on CANCELLED status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { getScrapeJob: { job: { jobId: 'job-123', status: 'CANCELLED' } } },
        }),
      });

      const result = await service.waitForCompletion('job-123', { pollInterval: 10 });

      expect(result.status).toBe('CANCELLED');
    });

    it('should throw RagstackTimeoutError on timeout', async () => {
      // Always return PROCESSING
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { getScrapeJob: { job: { jobId: 'job-123', status: 'PROCESSING' } } },
        }),
      });

      await expect(
        service.waitForCompletion('job-123', { pollInterval: 10, timeout: 50 })
      ).rejects.toThrow(RagstackTimeoutError);
    });

    it('should use default pollInterval of 2000ms', async () => {
      // Use shorter timeout to verify polling occurs
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: { getScrapeJob: { job: { jobId: 'job-123', status: 'PROCESSING' } } },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: { getScrapeJob: { job: { jobId: 'job-123', status: 'COMPLETED' } } },
          }),
        });

      // With default pollInterval, service should poll multiple times
      const result = await service.waitForCompletion('job-123', { timeout: 10000 });

      expect(result.status).toBe('COMPLETED');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
