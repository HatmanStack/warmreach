import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockFetchOk(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  });
}

describe('DynamoDBService', () => {
  let service: InstanceType<typeof import('./dynamoDBService.js').default>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.stubEnv('API_GATEWAY_BASE_URL', 'https://api.example.com/');

    // Reset modules to ensure environment variable is picked up if it's top-level
    vi.resetModules();
    const { default: DynamoDBService } = await import('./dynamoDBService.js');

    service = new DynamoDBService();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('setAuthToken', () => {
    it('should set auth token and include it in headers', async () => {
      service.setAuthToken('test-token');

      mockFetchOk({});
      await service.getProfileDetails('test-id');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        })
      );
    });
  });

  describe('getProfileDetails', () => {
    it('should return true if profile is stale', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 40); // 40 days ago

      mockFetchOk({
        profile: {
          updatedAt: oldDate.toISOString(),
        },
      });

      const isStale = await service.getProfileDetails('test-id');
      expect(isStale).toBe(true);
    });

    it('should return false if profile is fresh', async () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 5); // 5 days ago

      mockFetchOk({
        profile: {
          updatedAt: recentDate.toISOString(),
        },
      });

      const isStale = await service.getProfileDetails('test-id');
      expect(isStale).toBe(false);
    });

    it('should return true if profile does not exist', async () => {
      mockFetchOk({});
      const isStale = await service.getProfileDetails('test-id');
      expect(isStale).toBe(true);
    });
  });

  describe('markBadContact', () => {
    it('should call create operation with evaluated: true', async () => {
      mockFetchOk({ success: true });

      await service.markBadContact('bad-id');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('dynamodb'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"evaluated":true'),
        })
      );
    });

    it('should throw error if profileId is missing', async () => {
      // @ts-expect-error testing null input
      await expect(service.markBadContact(null)).rejects.toThrow('profileId is required');
    });
  });

  describe('upsertEdgeStatus', () => {
    it('should call upsert_status operation', async () => {
      mockFetchOk({ success: true });

      await service.upsertEdgeStatus('profile-123', 'connected');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('edges'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"operation":"upsert_status"'),
        })
      );
    });
  });

  describe('daily scrape cap', () => {
    it('canScrapeToday returns true when count is 0', async () => {
      mockFetchOk({ count: 0 });
      const result = await service.canScrapeToday();
      expect(result).toBe(true);
    });

    it('canScrapeToday returns false when count is 200', async () => {
      mockFetchOk({ count: 200 });
      const result = await service.canScrapeToday();
      expect(result).toBe(false);
    });

    it('incrementDailyScrapeCount calls the correct API endpoint', async () => {
      mockFetchOk({ count: 1 });
      const result = await service.incrementDailyScrapeCount();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('dynamodb'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"operation":"increment_daily_scrape_count"'),
        })
      );
      expect(result).toEqual({ count: 1 });
    });

    it('getDailyScrapeCount returns 0 when no data', async () => {
      mockFetchOk({});
      const count = await service.getDailyScrapeCount();
      expect(count).toBe(0);
    });
  });

  describe('import checkpoint', () => {
    it('saveImportCheckpoint calls correct API', async () => {
      mockFetchOk({ success: true });
      const checkpoint = {
        batchIndex: 2,
        lastProfileId: 'john-doe',
        connectionType: 'ally',
        processedCount: 50,
        totalCount: 200,
        updatedAt: '2026-03-13T00:00:00Z',
      };
      await service.saveImportCheckpoint(checkpoint);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('dynamodb'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"operation":"save_import_checkpoint"'),
        })
      );
    });

    it('getImportCheckpoint returns null when no checkpoint exists', async () => {
      mockFetchOk({});
      const result = await service.getImportCheckpoint();
      expect(result).toBeNull();
    });

    it('getImportCheckpoint returns saved checkpoint', async () => {
      const checkpoint = { batchIndex: 2, lastProfileId: 'john-doe' };
      mockFetchOk({ checkpoint });
      const result = await service.getImportCheckpoint();
      expect(result).toEqual(checkpoint);
    });

    it('clearImportCheckpoint calls correct API', async () => {
      mockFetchOk({ success: true });
      await service.clearImportCheckpoint();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('dynamodb'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"operation":"clear_import_checkpoint"'),
        })
      );
    });
  });

  describe('handleError', () => {
    it('should handle 401 error', () => {
      const error = Object.assign(new Error('Unauthorized'), { statusCode: 401 });
      const handled = service.handleError(error);
      expect(handled.message).toContain('Authentication required');
    });

    it('should handle network error', () => {
      const error = new TypeError('Failed to fetch');
      const handled = service.handleError(error);
      expect(handled.message).toContain('Network error');
    });
  });
});
