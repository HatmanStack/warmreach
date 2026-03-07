import { describe, it, expect, vi, beforeEach } from 'vitest';
import { connectionsApiService } from './connectionsApiService';
import { httpClient } from '@/shared/utils/httpClient';
import { ApiError } from '@/shared/utils/apiError';

vi.mock('@/shared/utils/httpClient', () => ({
  httpClient: {
    makeRequest: vi.fn(),
  },
}));

describe('ConnectionsApiService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getConnectionsByStatus', () => {
    it('should fetch and format connections', async () => {
      const mockConnections = [{ id: 'c1', first_name: 'John', last_name: 'Doe', status: 'ally' }];

      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: { connections: mockConnections, count: 1 },
      });

      const result = await connectionsApiService.getConnectionsByStatus('ally');

      expect(httpClient.makeRequest).toHaveBeenCalledWith('edges', 'get_connections_by_status', {
        updates: { status: 'ally' },
      });
      expect(result).toHaveLength(1);
      expect(result[0].first_name).toBe('John');
    });

    it('should throw ApiError on failure', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: false,
        error: 'Fetch failed',
        data: null,
      });

      await expect(connectionsApiService.getConnectionsByStatus()).rejects.toThrow(ApiError);
    });
  });

  describe('updateConnectionStatus', () => {
    it('should call update_metadata operation', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: { success: true, updated: {} },
      });

      await connectionsApiService.updateConnectionStatus('c1', 'ally');

      expect(httpClient.makeRequest).toHaveBeenCalledWith(
        'edges',
        'update_metadata',
        expect.objectContaining({
          profileId: 'c1',
          updates: expect.objectContaining({ status: 'ally' }),
        })
      );
    });

    it('should handle options.profileId', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: { success: true, updated: {} },
      });

      await connectionsApiService.updateConnectionStatus('c1', 'ally', { profileId: 'p1' });

      expect(httpClient.makeRequest).toHaveBeenCalledWith(
        'edges',
        'update_metadata',
        expect.objectContaining({
          profileId: 'p1',
        })
      );
    });
  });

  describe('computeRelationshipScores', () => {
    it('should call compute_relationship_scores operation', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: { scoresComputed: 10 },
      });

      const result = await connectionsApiService.computeRelationshipScores();

      expect(httpClient.makeRequest).toHaveBeenCalledWith('edges', 'compute_relationship_scores');
      expect(result.scoresComputed).toBe(10);
    });
  });
});
