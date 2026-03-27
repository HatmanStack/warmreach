import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processConnection, isConnectionLevelError } from './profileScraping';
import type { ProfileInitService } from './profileInitService';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../linkedin/utils/linkedinErrorHandler.js', () => ({
  LinkedInErrorHandler: {
    categorizeError: vi.fn().mockReturnValue({ category: 'SYSTEM' }),
  },
}));

describe('profileScraping', () => {
  let mockService: any;
  const state = { requestId: 'req1', jwtToken: 'token' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockService = {
      dynamoDBService: {
        canScrapeToday: vi.fn().mockResolvedValue(true),
        getProfileDetails: vi.fn().mockResolvedValue(true),
        createProfileMetadata: vi.fn().mockResolvedValue({}),
        incrementDailyScrapeCount: vi.fn().mockResolvedValue({}),
        upsertEdgeStatus: vi.fn().mockResolvedValue(true),
      },
      localProfileScraper: {
        scrapeProfile: vi.fn().mockResolvedValue({
          name: 'Jane Doe',
          headline: 'Engineer',
          location: 'SF',
          currentPosition: { title: 'Engineer', company: 'Acme' },
        }),
      },
      triggerRAGStackIngestion: vi.fn().mockResolvedValue(null),
    } as unknown as ProfileInitService;
  });

  describe('processConnection', () => {
    it('should scrape, create edge, and trigger ingestion', async () => {
      await processConnection(mockService, 'p1', state, 'ally');

      expect(mockService.dynamoDBService.upsertEdgeStatus).toHaveBeenCalledWith('p1', 'ally');
      expect(mockService.triggerRAGStackIngestion).toHaveBeenCalledWith('p1', state);
    });

    it('should skip scraping when daily cap reached', async () => {
      mockService.dynamoDBService.canScrapeToday.mockResolvedValue(false);

      await processConnection(mockService, 'p1', state, 'ally');

      expect(mockService.localProfileScraper.scrapeProfile).not.toHaveBeenCalled();
      expect(mockService.dynamoDBService.upsertEdgeStatus).toHaveBeenCalled();
    });

    it('should skip scraping when profile is fresh', async () => {
      mockService.dynamoDBService.getProfileDetails.mockResolvedValue(false);

      await processConnection(mockService, 'p1', state, 'ally');

      expect(mockService.localProfileScraper.scrapeProfile).not.toHaveBeenCalled();
    });

    it('should handle scrape failure gracefully and still create edge', async () => {
      mockService.localProfileScraper.scrapeProfile.mockRejectedValue(new Error('scrape failed'));

      await processConnection(mockService, 'p1', state, 'ally');

      expect(mockService.dynamoDBService.upsertEdgeStatus).toHaveBeenCalled();
    });

    it('should propagate edge creation errors', async () => {
      mockService.dynamoDBService.upsertEdgeStatus.mockRejectedValue(new Error('DynamoDB error'));

      await expect(processConnection(mockService, 'p1', state, 'ally')).rejects.toThrow(
        'DynamoDB error'
      );
    });

    it('should pass picture URL to metadata', async () => {
      await processConnection(mockService, 'p1', state, 'ally', 'https://pic.url');

      expect(mockService.dynamoDBService.createProfileMetadata).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ profilePictureUrl: 'https://pic.url' })
      );
    });
  });

  describe('isConnectionLevelError', () => {
    it('should classify profile not found as connection-level', () => {
      expect(isConnectionLevelError(new Error('Profile not found'))).toBe(true);
    });

    it('should classify profile private as connection-level', () => {
      expect(isConnectionLevelError(new Error('Profile is private'))).toBe(true);
    });

    it('should not classify network error as connection-level', () => {
      expect(isConnectionLevelError(new Error('Network timeout'))).toBe(false);
    });

    it('should classify scrape failure as connection-level', () => {
      expect(isConnectionLevelError(new Error('scrape failed for profile'))).toBe(true);
    });
  });
});
