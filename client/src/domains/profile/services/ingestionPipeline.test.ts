import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IngestionPipeline } from './ingestionPipeline.js';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

describe('IngestionPipeline', () => {
  let pipeline: IngestionPipeline;
  let mockRagstackProxy: {
    isConfigured: ReturnType<typeof vi.fn>;
    fetchProfile: ReturnType<typeof vi.fn>;
    ingest: ReturnType<typeof vi.fn>;
  };
  let mockGenerateProfileMarkdown: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRagstackProxy = {
      isConfigured: vi.fn().mockReturnValue(true),
      fetchProfile: vi.fn(),
      ingest: vi.fn(),
    };

    mockGenerateProfileMarkdown = vi.fn().mockReturnValue('# Test Profile\n\nTest content');

    pipeline = new IngestionPipeline({
      ragstackProxy: mockRagstackProxy as any,
      generateProfileMarkdown: mockGenerateProfileMarkdown,
    });
  });

  describe('triggerRAGStackIngestion', () => {
    it('should return documentId on successful ingestion', async () => {
      mockRagstackProxy.fetchProfile.mockResolvedValue({
        profile: {
          name: 'Jane Doe',
          headline: 'Engineer',
          ragstack_ingested: false,
        },
      });
      mockRagstackProxy.ingest.mockResolvedValue({ documentId: 'doc-123' });

      const result = await pipeline.triggerRAGStackIngestion('jane-doe', {
        requestId: 'req1',
        jwtToken: 'jwt',
      });

      expect(result).toEqual({ documentId: 'doc-123' });
      expect(mockGenerateProfileMarkdown).toHaveBeenCalled();
      expect(mockRagstackProxy.ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: 'jane-doe',
          markdownContent: '# Test Profile\n\nTest content',
        })
      );
    });

    it('should skip when RAGStack not configured', async () => {
      mockRagstackProxy.isConfigured.mockReturnValue(false);

      const result = await pipeline.triggerRAGStackIngestion('jane-doe', { requestId: 'req1' });

      expect(result).toBeNull();
      expect(mockRagstackProxy.fetchProfile).not.toHaveBeenCalled();
    });

    it('should skip already-ingested profiles', async () => {
      mockRagstackProxy.fetchProfile.mockResolvedValue({
        profile: {
          name: 'Jane Doe',
          ragstack_ingested: true,
        },
      });

      const result = await pipeline.triggerRAGStackIngestion('jane-doe', { requestId: 'req1' });

      expect(result).toBeNull();
      expect(mockRagstackProxy.ingest).not.toHaveBeenCalled();
    });

    it('should skip profiles without name', async () => {
      mockRagstackProxy.fetchProfile.mockResolvedValue({
        profile: {
          name: null,
          ragstack_ingested: false,
        },
      });

      const result = await pipeline.triggerRAGStackIngestion('jane-doe', { requestId: 'req1' });

      expect(result).toBeNull();
      expect(mockRagstackProxy.ingest).not.toHaveBeenCalled();
    });

    it('should skip when profile not found in DynamoDB', async () => {
      mockRagstackProxy.fetchProfile.mockResolvedValue(null);

      const result = await pipeline.triggerRAGStackIngestion('jane-doe', { requestId: 'req1' });

      expect(result).toBeNull();
    });

    it('should handle ingestion errors gracefully (non-fatal)', async () => {
      mockRagstackProxy.fetchProfile.mockResolvedValue({
        profile: {
          name: 'Jane Doe',
          ragstack_ingested: false,
        },
      });
      mockRagstackProxy.ingest.mockRejectedValue(new Error('Network error'));

      const result = await pipeline.triggerRAGStackIngestion('jane-doe', { requestId: 'req1' });

      expect(result).toBeNull();
      // Should not throw
    });
  });
});
