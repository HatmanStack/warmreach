import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BatchProcessor } from './batchProcessor.js';

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

vi.mock('../utils/profileInitMonitor.js', () => ({
  profileInitMonitor: {
    recordConnection: vi.fn(),
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

describe('BatchProcessor', () => {
  let processor: BatchProcessor;
  let mockDynamo: Record<string, ReturnType<typeof vi.fn>>;
  let mockLinkedIn: Record<string, ReturnType<typeof vi.fn>>;
  let mockLocalScraper: Record<string, ReturnType<typeof vi.fn>>;
  let mockBurstThrottle: Record<string, ReturnType<typeof vi.fn>>;
  let mockInteractionQueue: Record<string, ReturnType<typeof vi.fn>>;
  let mockBackoffController: Record<string, ReturnType<typeof vi.fn>>;
  let mockRagstackProxy: Record<string, ReturnType<typeof vi.fn>>;
  let mockPuppeteer: Record<string, ReturnType<typeof vi.fn>>;
  let mockIngestionPipeline: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();

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
      markBadContact: vi.fn().mockResolvedValue(undefined),
    };

    mockLinkedIn = {
      login: vi.fn().mockResolvedValue(true),
      getConnections: vi.fn().mockResolvedValue(['p1', 'p2']),
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

    mockInteractionQueue = { setImportMode: vi.fn() };
    mockBackoffController = { setImportMode: vi.fn() };
    mockRagstackProxy = {
      isConfigured: vi.fn().mockReturnValue(false),
    };
    mockPuppeteer = {
      extractProfilePictures: vi.fn().mockResolvedValue({}),
    };
    mockIngestionPipeline = {
      triggerRAGStackIngestion: vi.fn().mockResolvedValue(null),
    };

    processor = new BatchProcessor({
      dynamoDBService: mockDynamo as any,
      linkedInService: mockLinkedIn as any,
      localProfileScraper: mockLocalScraper as any,
      burstThrottleManager: mockBurstThrottle as any,
      interactionQueue: mockInteractionQueue as any,
      backoffController: mockBackoffController as any,
      ragstackProxy: mockRagstackProxy as any,
      puppeteer: mockPuppeteer as any,
      ingestionPipeline: mockIngestionPipeline as any,
      batchSize: 100,
    });
  });

  describe('processConnectionLists', () => {
    it('should process all connection types', async () => {
      const state = { requestId: 'req1', jwtToken: 'token' };

      const result = await processor.processConnectionLists(state);

      expect(result.processed).toBeGreaterThanOrEqual(0);
      expect(mockLinkedIn.getConnections).toHaveBeenCalled();
      expect(mockInteractionQueue.setImportMode).toHaveBeenCalledWith(true);
    });

    it('should enable and disable import mode', async () => {
      const state = { requestId: 'req1' };

      await processor.processConnectionLists(state);

      expect(mockInteractionQueue.setImportMode).toHaveBeenCalledWith(true);
      expect(mockInteractionQueue.setImportMode).toHaveBeenCalledWith(false);
    });
  });

  describe('_processConnection', () => {
    it('should create edge and trigger ingestion', async () => {
      const state = { requestId: 'req1', jwtToken: 'token' };

      await processor._processConnection('p1', state, 'ally');

      expect(mockDynamo.upsertEdgeStatus).toHaveBeenCalledWith('p1', 'ally');
      expect(mockIngestionPipeline.triggerRAGStackIngestion).toHaveBeenCalledWith('p1', state);
    });

    it('should scrape profile when fresh check indicates stale', async () => {
      const state = { requestId: 'req1', jwtToken: 'token' };
      mockDynamo.getProfileDetails.mockResolvedValue(true); // stale

      await processor._processConnection('p1', state, 'ally');

      expect(mockLocalScraper.scrapeProfile).toHaveBeenCalledWith('p1');
      expect(mockDynamo.createProfileMetadata).toHaveBeenCalled();
    });
  });

  describe('_isConnectionLevelError', () => {
    it('should correctly classify profile not found errors', () => {
      expect(processor._isConnectionLevelError(new Error('profile not found'))).toBe(true);
      expect(processor._isConnectionLevelError(new Error('profile is private'))).toBe(true);
      expect(processor._isConnectionLevelError(new Error('scrape failed for profile'))).toBe(true);
    });

    it('should not classify system errors as connection-level', () => {
      expect(processor._isConnectionLevelError(new Error('Network timeout'))).toBe(false);
      expect(processor._isConnectionLevelError(new Error('DynamoDB error'))).toBe(false);
    });
  });

  describe('_processBatch', () => {
    it('should handle individual connections with error isolation', async () => {
      const state = { requestId: 'req1', jwtToken: 'token' };

      const result = await processor._processBatch('data/ally-connections-batch-0.json', state);

      expect(result.batchNumber).toBe(0);
      expect(result.processed + result.skipped + result.errors).toBe(2);
    });

    it('should skip already-existing edges', async () => {
      mockDynamo.checkEdgeExists.mockResolvedValue(true);
      const state = { requestId: 'req1' };

      const result = await processor._processBatch('data/ally-connections-batch-0.json', state);

      expect(result.skipped).toBe(2);
      expect(result.processed).toBe(0);
    });
  });
});
