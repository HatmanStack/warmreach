import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processConnection, isConnectionLevelError } from './profileScraping';
import type { ProfileInitService } from './profileInitService';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// Pin the dev-only forceRescrape toggle off so an ambient
// PROFILE_INIT_FORCE_RESCRAPE=true (a developer's .env) can't flip the
// default-behavior assertions below.
vi.mock('#shared-config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#shared-config/index.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      linkedin: { ...actual.config.linkedin, forceRescrape: false },
    },
  };
});

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

    it('writes the scraped profile photo and ignores the list-page picture URL', async () => {
      // The list-page URL (5th arg) resolves to the viewer's own avatar in the
      // 2026 DOM, so it must be ignored; the photo comes from the member's own
      // scraped profile page.
      mockService.localProfileScraper.scrapeProfile.mockResolvedValue({
        name: 'Jane Doe',
        headline: 'Engineer',
        location: 'SF',
        currentPosition: { title: 'Engineer', company: 'Acme' },
        profilePictureUrl: 'https://media.licdn.com/own-photo',
      });

      await processConnection(mockService, 'p1', state, 'ally', 'https://list-page-viewer-avatar');

      expect(mockService.dynamoDBService.createProfileMetadata).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ profilePictureUrl: 'https://media.licdn.com/own-photo' })
      );
    });

    it('omits the photo when the scrape yields none (no list-page fallback)', async () => {
      // Base scrapeProfile mock returns no profilePictureUrl. Even with a
      // list-page URL passed, none must be written — better initials than the
      // wrong (viewer) avatar.
      await processConnection(mockService, 'p1', state, 'ally', 'https://list-page-viewer-avatar');

      const call = mockService.dynamoDBService.createProfileMetadata.mock.calls[0];
      expect(call?.[1]).not.toHaveProperty('profilePictureUrl');
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
