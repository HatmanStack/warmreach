import { describe, it, expect, vi, beforeEach } from 'vitest';
import { activityApiService } from './activityApiService';
import { httpClient } from '@/shared/utils/httpClient';
import { ApiError } from '@/shared/utils/apiError';

vi.mock('@/shared/utils/httpClient', () => ({
  httpClient: {
    makeRequest: vi.fn(),
  },
}));

describe('ActivityApiService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getActivityTimeline', () => {
    it('should call httpClient with correct endpoint and operation', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: { activities: [], nextCursor: null, count: 0 },
      });

      await activityApiService.getActivityTimeline();

      expect(httpClient.makeRequest).toHaveBeenCalledWith('edges', 'get_activity_timeline', {});
    });

    it('should pass through all filter params', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: { activities: [], nextCursor: null, count: 0 },
      });

      const params = {
        eventType: 'connection_status_change',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        limit: 20,
        cursor: 'abc123',
      };

      await activityApiService.getActivityTimeline(params);

      expect(httpClient.makeRequest).toHaveBeenCalledWith('edges', 'get_activity_timeline', params);
    });

    it('should return typed ActivityTimelineResponse', async () => {
      const mockData = {
        activities: [
          { eventType: 'message_sent', timestamp: '2024-01-01T10:00:00Z', metadata: {} },
        ],
        nextCursor: 'next-cursor-token',
        count: 1,
      };

      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: mockData,
      });

      const result = await activityApiService.getActivityTimeline();

      expect(result.activities).toHaveLength(1);
      expect(result.nextCursor).toBe('next-cursor-token');
      expect(result.count).toBe(1);
    });

    it('should throw ApiError on failure', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: false,
        error: { message: 'Failed to fetch timeline' },
        data: null,
      });

      await expect(activityApiService.getActivityTimeline()).rejects.toThrow(ApiError);
    });
  });
});
