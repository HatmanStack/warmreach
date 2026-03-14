import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProfileInitService } from './profileInitService';
import { LinkedInErrorHandler } from '../../linkedin/utils/linkedinErrorHandler.js';
import axios from 'axios';

// Mock dependencies
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('#utils/randomHelpers.js', () => ({
  RandomHelpers: {
    randomDelay: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../utils/profileInitStateManager.js', () => ({
  ProfileInitStateManager: {
    isResumingState: vi.fn().mockReturnValue(false),
    validateState: vi.fn(),
    getProgressSummary: vi.fn().mockReturnValue({}),
    updateBatchProgress: vi.fn().mockImplementation((s) => s),
  },
}));

vi.mock('../../linkedin/utils/linkedinErrorHandler.js', () => ({
  LinkedInErrorHandler: {
    categorizeError: vi.fn().mockReturnValue({ category: 'SYSTEM' }),
  },
}));

vi.mock('fs/promises', () => ({
  default: {
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockImplementation(async (filePath: string) => {
      if (filePath.includes('index')) {
        return JSON.stringify({
          metadata: { totalAllies: 2, totalIncoming: 0, totalOutgoing: 0 },
          files: { allyConnections: [], incomingConnections: [], outgoingConnections: [] },
          processingState: { completedBatches: [] },
        });
      }
      return JSON.stringify({
        batchNumber: 0,
        connectionType: 'ally',
        connections: ['p1', 'p2'],
      });
    }),
  },
}));

vi.mock('axios');

describe('ProfileInitService', () => {
  let service: ProfileInitService;
  let mockPuppeteer;
  let mockLinkedIn;
  let mockContact;
  let mockDynamo;
  let mockLocalScraper;
  let mockBurstThrottle;
  let mockInteractionQueue;
  let mockBackoffController;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPuppeteer = { extractProfilePictures: vi.fn().mockResolvedValue({}) };
    mockLinkedIn = {
      login: vi.fn().mockResolvedValue(true),
      getConnections: vi.fn().mockResolvedValue(['p1', 'p2']),
    };
    mockContact = { scrapeProfile: vi.fn().mockResolvedValue({ success: true }) };
    mockDynamo = {
      setAuthToken: vi.fn(),
      checkEdgeExists: vi.fn().mockResolvedValue(false),
      upsertEdgeStatus: vi.fn().mockResolvedValue(true),
      updateMessages: vi.fn().mockResolvedValue(true),
      getProfileDetails: vi.fn().mockResolvedValue(true),
      createProfileMetadata: vi.fn().mockResolvedValue({}),
      canScrapeToday: vi.fn().mockResolvedValue(true),
      incrementDailyScrapeCount: vi.fn().mockResolvedValue({ count: 1 }),
      saveImportCheckpoint: vi.fn().mockResolvedValue({}),
      getImportCheckpoint: vi.fn().mockResolvedValue(null),
      clearImportCheckpoint: vi.fn().mockResolvedValue({}),
    };
    mockLocalScraper = {
      scrapeProfile: vi.fn().mockResolvedValue({
        name: 'Jane Doe',
        headline: 'Engineer',
        location: 'SF',
        about: 'About',
        currentPosition: { title: 'Engineer', company: 'Acme' },
        experience: [],
        education: [],
        skills: ['JS'],
        recentActivity: [],
      }),
    };
    mockBurstThrottle = {
      waitForNext: vi.fn().mockResolvedValue({ delayed: true, delayMs: 0 }),
      reset: vi.fn(),
    };
    mockInteractionQueue = {
      setImportMode: vi.fn(),
    };
    mockBackoffController = {
      setImportMode: vi.fn(),
    };

    service = new ProfileInitService(
      mockPuppeteer,
      mockLinkedIn,
      mockContact,
      mockDynamo,
      mockLocalScraper,
      mockBurstThrottle,
      mockInteractionQueue,
      mockBackoffController
    );
  });

  describe('initializeUserProfile', () => {
    it('should complete full initialization successfully', async () => {
      const state = { requestId: 'req1', jwtToken: 'token' };

      const result = await service.initializeUserProfile(state);

      expect(result.success).toBe(true);
      expect(mockLinkedIn.login).toHaveBeenCalled();
      expect(mockLinkedIn.getConnections).toHaveBeenCalled();
      expect(mockDynamo.upsertEdgeStatus).toHaveBeenCalled();
    });

    it('should handle errors and categorize them', async () => {
      const state = { requestId: 'req1' };
      mockLinkedIn.login.mockRejectedValue(new Error('Login failed'));

      await expect(service.initializeUserProfile(state)).rejects.toThrow('Login failed');
      expect(LinkedInErrorHandler.categorizeError).toHaveBeenCalled();
    });
  });

  describe('local scraper integration', () => {
    it('should scrape stale profiles with local scraper', async () => {
      const state = { requestId: 'req1', jwtToken: 'token' };
      mockDynamo.getProfileDetails.mockResolvedValue(true); // stale

      const result = await service.initializeUserProfile(state);
      expect(result.success).toBe(true);
      expect(mockLocalScraper.scrapeProfile).toHaveBeenCalled();
      expect(mockDynamo.createProfileMetadata).toHaveBeenCalled();
    });

    it('should skip scraping when profile is fresh', async () => {
      const state = { requestId: 'req1', jwtToken: 'token' };
      mockDynamo.getProfileDetails.mockResolvedValue(false); // fresh

      const result = await service.initializeUserProfile(state);
      expect(result.success).toBe(true);
      expect(mockLocalScraper.scrapeProfile).not.toHaveBeenCalled();
    });

    it('should skip scraping when daily cap reached', async () => {
      const state = { requestId: 'req1', jwtToken: 'token' };
      mockDynamo.canScrapeToday.mockResolvedValue(false);

      const result = await service.initializeUserProfile(state);
      expect(result.success).toBe(true);
      expect(mockLocalScraper.scrapeProfile).not.toHaveBeenCalled();
      // Edge should still be created
      expect(mockDynamo.upsertEdgeStatus).toHaveBeenCalled();
    });

    it('should increment daily counter after successful scrape', async () => {
      const state = { requestId: 'req1', jwtToken: 'token' };
      mockDynamo.getProfileDetails.mockResolvedValue(true);

      await service.initializeUserProfile(state);
      expect(mockDynamo.incrementDailyScrapeCount).toHaveBeenCalled();
    });

    it('should handle scrape failure gracefully', async () => {
      const state = { requestId: 'req1', jwtToken: 'token' };
      mockDynamo.getProfileDetails.mockResolvedValue(true);
      mockLocalScraper.scrapeProfile.mockRejectedValue(new Error('scrape failed'));

      const result = await service.initializeUserProfile(state);
      expect(result.success).toBe(true);
      // Should still create edge
      expect(mockDynamo.upsertEdgeStatus).toHaveBeenCalled();
    });
  });

  describe('import mode toggling', () => {
    it('should enable import mode at start and disable at end', async () => {
      const state = { requestId: 'req1', jwtToken: 'token' };

      await service.initializeUserProfile(state);

      expect(mockInteractionQueue.setImportMode).toHaveBeenCalledWith(true);
      expect(mockInteractionQueue.setImportMode).toHaveBeenCalledWith(false);
      expect(mockBackoffController.setImportMode).toHaveBeenCalledWith(true);
      expect(mockBackoffController.setImportMode).toHaveBeenCalledWith(false);
    });

    it('should disable import mode on error', async () => {
      const state = { requestId: 'req1', jwtToken: 'token' };
      mockLinkedIn.getConnections.mockRejectedValue(new Error('fail'));

      try {
        await service.initializeUserProfile(state);
      } catch {
        // expected
      }

      // Import mode should still be disabled in finally
      expect(mockInteractionQueue.setImportMode).toHaveBeenCalledWith(false);
      expect(mockBackoffController.setImportMode).toHaveBeenCalledWith(false);
    });
  });

  describe('burst throttling', () => {
    it('should call waitForNext before processing each connection', async () => {
      const state = { requestId: 'req1', jwtToken: 'token' };

      await service.initializeUserProfile(state);

      // waitForNext should be called for each connection processed
      expect(mockBurstThrottle.waitForNext).toHaveBeenCalled();
      // At least once per connection (2 per type, 3 types = up to 6)
      expect(mockBurstThrottle.waitForNext.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('import checkpoint', () => {
    it('should save checkpoint after each connection', async () => {
      const state = { requestId: 'req1', jwtToken: 'token' };

      await service.initializeUserProfile(state);

      expect(mockDynamo.saveImportCheckpoint).toHaveBeenCalled();
    });

    it('should clear checkpoint on completion', async () => {
      const state = { requestId: 'req1', jwtToken: 'token' };

      await service.initializeUserProfile(state);

      expect(mockDynamo.clearImportCheckpoint).toHaveBeenCalled();
    });

    it('should load checkpoint on startup and resume from saved position', async () => {
      mockDynamo.getImportCheckpoint.mockResolvedValue({
        connectionType: 'ally',
        batchIndex: 0,
        lastProfileId: 'p1',
      });

      const state = { requestId: 'req1', jwtToken: 'token' };

      await service.initializeUserProfile(state);

      expect(mockDynamo.getImportCheckpoint).toHaveBeenCalled();
    });

    it('should not set resume state when checkpoint is null', async () => {
      mockDynamo.getImportCheckpoint.mockResolvedValue(null);

      const state = { requestId: 'req1', jwtToken: 'token' };

      await service.initializeUserProfile(state);

      expect(mockDynamo.getImportCheckpoint).toHaveBeenCalled();
      // All connection types should be processed (no skipping)
      expect(mockLinkedIn.getConnections).toHaveBeenCalledTimes(3);
    });
  });

  describe('triggerRAGStackIngestion', () => {
    it('should skip if API URL not set', async () => {
      delete process.env.API_GATEWAY_BASE_URL;
      const result = await service.triggerRAGStackIngestion('p1', {});
      expect(result).toBeNull();
    });

    it('should ingest profile if data is available', async () => {
      // Must set env before constructing service so RagstackProxyService picks it up
      process.env.API_GATEWAY_BASE_URL = 'https://api.test';
      const freshService = new ProfileInitService(
        mockPuppeteer,
        mockLinkedIn,
        mockContact,
        mockDynamo,
        mockLocalScraper,
        mockBurstThrottle,
        mockInteractionQueue,
        mockBackoffController
      );

      (axios.get as any).mockResolvedValue({
        data: { profile: { name: 'John Doe', headline: 'Engineer' } },
      });
      (axios.post as any).mockResolvedValue({ data: { documentId: 'doc1' } });

      const result = await freshService.triggerRAGStackIngestion('p1', { jwtToken: 't' });

      expect(result).toEqual({ documentId: 'doc1' });
      expect(axios.post).toHaveBeenCalled();
    });
  });
});
