import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBatchFiles, processBatch } from './profileBatchProcessing';
import { processConnection } from './profileScraping.js';
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

vi.mock('#utils/randomHelpers.js', () => ({
  RandomHelpers: {
    randomDelay: vi.fn().mockResolvedValue(undefined),
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
    readFile: vi.fn().mockImplementation(async (_filePath: string) => {
      return JSON.stringify({
        batchNumber: 0,
        connectionType: 'ally',
        connections: ['p1', 'p2'],
      });
    }),
  },
}));

// Mock processConnection from profileScraping
vi.mock('./profileScraping.js', () => ({
  processConnection: vi.fn().mockResolvedValue(undefined),
  isConnectionLevelError: vi.fn().mockReturnValue(false),
}));

describe('profileBatchProcessing', () => {
  let mockService: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockService = {
      batchSize: 100,
      dynamoDBService: {
        checkEdgeExists: vi.fn().mockResolvedValue(false),
        getEdgeState: vi.fn().mockResolvedValue({ exists: false, status: null }),
        saveImportCheckpoint: vi.fn().mockResolvedValue({}),
      },
      burstThrottleManager: {
        waitForNext: vi.fn().mockResolvedValue({ delayed: false, delayMs: 0 }),
      },
    } as unknown as ProfileInitService;
  });

  describe('createBatchFiles', () => {
    it('should create batch files and update master index', async () => {
      const masterIndex = {
        metadata: {},
        files: {},
        processingState: { completedBatches: [] },
      } as any;

      const connections = ['p1', 'p2', 'p3'];
      const result = await createBatchFiles(mockService, 'ally', connections, masterIndex);

      expect(result).toHaveLength(1); // 3 connections, batchSize=100, so 1 batch
      expect(masterIndex.files['allyConnections']).toHaveLength(1);
    });

    it('should split into multiple batches when connections exceed batch size', async () => {
      mockService.batchSize = 2;
      const masterIndex = {
        metadata: {},
        files: {},
        processingState: { completedBatches: [] },
      } as any;

      const connections = ['p1', 'p2', 'p3'];
      const result = await createBatchFiles(mockService, 'outgoing', connections, masterIndex);

      expect(result).toHaveLength(2); // ceil(3/2) = 2 batches
    });
  });

  describe('processBatch', () => {
    it('should process all connections in a batch', async () => {
      const state = { requestId: 'req1' };
      const result = await processBatch(mockService, 'data/batch.json', state);

      expect(result.processed).toBe(2); // p1, p2
      expect(result.errors).toBe(0);
    });

    it('should skip connections where an already-synced edge exists', async () => {
      // Batch is connectionType 'ally' and the stored status is already 'ally'
      // (no conversion) -> short-circuit.
      mockService.dynamoDBService.getEdgeState.mockResolvedValue({
        exists: true,
        status: 'ally',
      });
      const state = { requestId: 'req1' };
      const result = await processBatch(mockService, 'data/batch.json', state);

      expect(result.skipped).toBe(2);
      expect(result.processed).toBe(0);
    });

    it('should re-scrape (not skip) when a possible/outgoing contact converts to ally', async () => {
      // Batch is connectionType 'ally'; stored edge status is 'possible' -> this
      // is a conversion, so the profile must be re-scraped with forceScrape=true
      // rather than skipped.
      const { processConnection } = await import('./profileScraping.js');
      mockService.dynamoDBService.getEdgeState.mockResolvedValue({
        exists: true,
        status: 'possible',
      });
      const state = { requestId: 'req1' };
      const result = await processBatch(mockService, 'data/batch.json', state);

      expect(result.skipped).toBe(0);
      expect(result.processed).toBe(2);
      // 6th arg (forceScrape) must be true for a conversion.
      expect(processConnection).toHaveBeenCalledWith(
        mockService,
        'p1',
        expect.anything(),
        'ally',
        undefined,
        true
      );
    });

    it('should use burst throttle between connections', async () => {
      const state = { requestId: 'req1' };
      await processBatch(mockService, 'data/batch.json', state);

      expect(mockService.burstThrottleManager.waitForNext).toHaveBeenCalledTimes(2);
    });

    it('should save checkpoint after each connection', async () => {
      const state = { requestId: 'req1' };
      await processBatch(mockService, 'data/batch.json', state);

      expect(mockService.dynamoDBService.saveImportCheckpoint).toHaveBeenCalledTimes(2);
    });

    it('halts per-connection processing (and thus collection) after a mid-loop abort', async () => {
      // A serious (non-connection-level) error from the backoff/abort path on the
      // first connection must stop the loop, so the second connection is never
      // processed — and therefore never has its mutuals collected.
      vi.mocked(processConnection).mockRejectedValueOnce(new Error('429 backoff abort'));

      const state = { requestId: 'req1', collectMutuals: true };

      await expect(processBatch(mockService, 'data/batch.json', state)).rejects.toThrow(
        '429 backoff abort'
      );
      expect(processConnection).toHaveBeenCalledTimes(1);
    });
  });
});
