import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  triggerRAGStackIngestion,
  createMasterIndexFile,
  loadMasterIndex,
  updateMasterIndex,
} from './profileIngestion';
import type { ProfileInitService } from './profileInitService';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../utils/profileMarkdownGenerator.js', () => ({
  generateProfileMarkdown: vi.fn().mockReturnValue('# Profile'),
}));

vi.mock('fs/promises', () => ({
  default: {
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(
      JSON.stringify({
        metadata: {
          capturedAt: '',
          totalAllies: 0,
          totalIncoming: 0,
          totalOutgoing: 0,
          batchSize: 100,
        },
        files: { allyConnections: [], incomingConnections: [], outgoingConnections: [] },
        processingState: {
          currentList: 'ally',
          currentBatch: 0,
          currentIndex: 0,
          completedBatches: [],
        },
      })
    ),
  },
}));

describe('profileIngestion', () => {
  let mockService: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockService = {
      batchSize: 100,
      ragstackProxy: {
        isConfigured: vi.fn().mockReturnValue(false),
        fetchProfile: vi.fn().mockResolvedValue(null),
        ingest: vi.fn().mockResolvedValue({ documentId: 'doc1' }),
      },
    } as unknown as ProfileInitService;
  });

  afterEach(() => {
    delete process.env.API_GATEWAY_BASE_URL;
  });

  describe('triggerRAGStackIngestion', () => {
    it('should skip when API URL not configured', async () => {
      const result = await triggerRAGStackIngestion(mockService, 'p1', {});
      expect(result).toBeNull();
    });

    it('should skip when profile not found', async () => {
      mockService.ragstackProxy.isConfigured.mockReturnValue(true);
      mockService.ragstackProxy.fetchProfile.mockResolvedValue(null);

      const result = await triggerRAGStackIngestion(mockService, 'p1', { jwtToken: 't' });
      expect(result).toBeNull();
    });

    it('should skip when profile already ingested', async () => {
      mockService.ragstackProxy.isConfigured.mockReturnValue(true);
      mockService.ragstackProxy.fetchProfile.mockResolvedValue({
        profile: { name: 'John', ragstack_ingested: true },
      });

      const result = await triggerRAGStackIngestion(mockService, 'p1', { jwtToken: 't' });
      expect(result).toBeNull();
    });

    it('should skip when profile missing name', async () => {
      mockService.ragstackProxy.isConfigured.mockReturnValue(true);
      mockService.ragstackProxy.fetchProfile.mockResolvedValue({
        profile: { headline: 'Engineer' },
      });

      const result = await triggerRAGStackIngestion(mockService, 'p1', { jwtToken: 't' });
      expect(result).toBeNull();
    });

    it('should ingest profile when data is available', async () => {
      mockService.ragstackProxy.isConfigured.mockReturnValue(true);
      mockService.ragstackProxy.fetchProfile.mockResolvedValue({
        profile: { name: 'John Doe', headline: 'Engineer' },
      });

      const result = await triggerRAGStackIngestion(mockService, 'p1', { jwtToken: 't' });
      expect(result).toEqual({ documentId: 'doc1' });
      expect(mockService.ragstackProxy.ingest).toHaveBeenCalled();
    });

    it('should handle ingestion errors gracefully', async () => {
      mockService.ragstackProxy.isConfigured.mockReturnValue(true);
      mockService.ragstackProxy.fetchProfile.mockRejectedValue(new Error('network'));

      const result = await triggerRAGStackIngestion(mockService, 'p1', {});
      expect(result).toBeNull(); // non-fatal
    });
  });

  describe('createMasterIndexFile', () => {
    it('should create a master index file', async () => {
      const filePath = await createMasterIndexFile(mockService);
      expect(filePath).toMatch(/profile-init-index-\d+\.json/);
    });
  });

  describe('loadMasterIndex', () => {
    it('should load and parse master index', async () => {
      const result = await loadMasterIndex(mockService, 'data/index.json');
      expect(result.metadata).toBeDefined();
      expect(result.files).toBeDefined();
    });
  });

  describe('updateMasterIndex', () => {
    it('should write master index to file', async () => {
      const fs = (await import('fs/promises')).default;
      const masterIndex = {
        metadata: {
          capturedAt: '',
          totalAllies: 0,
          totalIncoming: 0,
          totalOutgoing: 0,
          batchSize: 100,
        },
        files: { allyConnections: [], incomingConnections: [], outgoingConnections: [] },
        processingState: {
          currentList: 'ally',
          currentBatch: 0,
          currentIndex: 0,
          completedBatches: [],
        },
      } as any;

      await updateMasterIndex(mockService, 'data/index.json', masterIndex);
      expect(fs.writeFile).toHaveBeenCalled();
    });
  });
});
