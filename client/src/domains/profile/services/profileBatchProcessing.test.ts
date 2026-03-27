import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBatchFiles, processBatch } from './profileBatchProcessing';
import type { ProfileInitService } from './profileInitService';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

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

    it('should skip connections where edge already exists', async () => {
      mockService.dynamoDBService.checkEdgeExists.mockResolvedValue(true);
      const state = { requestId: 'req1' };
      const result = await processBatch(mockService, 'data/batch.json', state);

      expect(result.skipped).toBe(2);
      expect(result.processed).toBe(0);
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
  });
});
