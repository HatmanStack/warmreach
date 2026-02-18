import { vi, describe, it, expect, beforeEach, afterEach, type Mock } from 'vitest';

// Use vi.hoisted to create mock functions that are available at mock initialization time
const { mockExtractLinkedInCookies, mockAxiosPost } = vi.hoisted(() => ({
  mockExtractLinkedInCookies: vi.fn(),
  mockAxiosPost: vi.fn(),
}));

// Mock dependencies before importing the module
vi.mock('../../ragstack/index.js', () => ({
  extractLinkedInCookies: mockExtractLinkedInCookies,
}));

vi.mock('axios', () => ({
  default: { post: mockAxiosPost },
}));

vi.mock('#utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { LinkedInContactService } from './linkedinContactService.js';

describe('LinkedInContactService', () => {
  let service: LinkedInContactService;
  let mockPuppeteerService: { getPage: Mock };
  const originalEnv = process.env.API_GATEWAY_BASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_GATEWAY_BASE_URL = 'https://api.example.com/';

    mockPuppeteerService = {
      getPage: vi.fn().mockReturnValue({
        cookies: vi.fn().mockResolvedValue([]),
      }),
    };

    mockExtractLinkedInCookies.mockResolvedValue('li_at=token; JSESSIONID=ajax:123');

    // Default: scrape_start returns COMPLETED immediately (no polling needed)
    mockAxiosPost.mockResolvedValue({
      data: {
        jobId: 'job-123',
        baseUrl: 'https://www.linkedin.com/in/john-doe/',
        status: 'COMPLETED',
        processedCount: 2,
        totalUrls: 2,
        failedCount: 0,
      },
    });

    service = new LinkedInContactService(mockPuppeteerService as any);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.API_GATEWAY_BASE_URL;
    } else {
      process.env.API_GATEWAY_BASE_URL = originalEnv;
    }
  });

  describe('constructor', () => {
    it('should initialize when API_GATEWAY_BASE_URL is set', () => {
      expect(service).toBeDefined();
    });

    it('should report not configured when API_GATEWAY_BASE_URL is missing', async () => {
      delete process.env.API_GATEWAY_BASE_URL;
      const unconfiguredService = new LinkedInContactService(mockPuppeteerService as any);

      const result = await unconfiguredService.scrapeProfile('test');
      expect(result.success).toBe(false);
      expect(result.message).toContain('not configured');
    });
  });

  describe('scrapeProfile', () => {
    it('should scrape profile successfully', async () => {
      const result = await service.scrapeProfile('john-doe');

      expect(result.success).toBe(true);
      expect(result.jobId).toBe('job-123');
      expect(result.profileId).toBe('john-doe');
      expect(result.message).toContain('successfully');
      expect(mockExtractLinkedInCookies).toHaveBeenCalled();
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://api.example.com/ragstack',
        {
          operation: 'scrape_start',
          profileId: 'john-doe',
          cookies: 'li_at=token; JSESSIONID=ajax:123',
        },
        expect.objectContaining({ headers: expect.any(Object) })
      );
    });

    it('should include Authorization header when token is set', async () => {
      service.setAuthToken('my-jwt-token');
      await service.scrapeProfile('john-doe');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer my-jwt-token',
          }),
        })
      );
    });

    it('should poll for completion when initial status is not terminal', async () => {
      // First call (scrape_start) returns PENDING
      mockAxiosPost
        .mockResolvedValueOnce({
          data: {
            jobId: 'job-123',
            baseUrl: 'https://www.linkedin.com/in/john-doe/',
            status: 'PENDING',
          },
        })
        // Second call (scrape_status poll) returns COMPLETED
        .mockResolvedValueOnce({
          data: {
            jobId: 'job-123',
            status: 'COMPLETED',
            processedCount: 2,
            totalUrls: 2,
            failedCount: 0,
          },
        });

      const result = await service.scrapeProfile('john-doe');

      expect(result.success).toBe(true);
      expect(mockAxiosPost).toHaveBeenCalledTimes(2);
      expect(mockAxiosPost).toHaveBeenLastCalledWith(
        'https://api.example.com/ragstack',
        { operation: 'scrape_status', jobId: 'job-123' },
        expect.any(Object)
      );
    });

    it('should return failure when browser not initialized', async () => {
      mockPuppeteerService.getPage.mockReturnValue(null);

      const result = await service.scrapeProfile('john-doe');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Browser not initialized');
    });

    it('should handle scrape failures', async () => {
      mockAxiosPost.mockResolvedValue({
        data: {
          jobId: 'job-123',
          status: 'FAILED',
          baseUrl: 'https://www.linkedin.com/in/john-doe/',
        },
      });

      const result = await service.scrapeProfile('john-doe');

      expect(result.success).toBe(false);
      expect(result.message).toContain('FAILED');
    });

    it('should handle network errors gracefully', async () => {
      mockAxiosPost.mockRejectedValue(new Error('Network error'));

      const result = await service.scrapeProfile('john-doe');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Network error');
    });

    it('should pass status parameter to logging', async () => {
      await service.scrapeProfile('john-doe', 'ally');

      expect(mockAxiosPost).toHaveBeenCalled();
    });
  });

  describe('takeScreenShotAndUploadToS3 (deprecated)', () => {
    it('should call scrapeProfile internally', async () => {
      const result = await service.takeScreenShotAndUploadToS3('john-doe', 'ally');

      expect(result.success).toBe(true);
      expect(mockAxiosPost).toHaveBeenCalled();
    });

    it('should return compatible response format', async () => {
      const result = await service.takeScreenShotAndUploadToS3('john-doe', 'ally');

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('message');
      expect(result.data).toHaveProperty('jobId');
    });

    it('should handle failures from scrapeProfile', async () => {
      mockAxiosPost.mockRejectedValue(new Error('API error'));

      const result = await service.takeScreenShotAndUploadToS3('john-doe', 'ally');

      expect(result.success).toBe(false);
      expect(result.message).toContain('API error');
    });
  });
});
