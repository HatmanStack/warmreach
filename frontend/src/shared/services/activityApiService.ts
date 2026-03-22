import { httpClient } from '@/shared/utils/httpClient';
import { ApiError } from '@/shared/utils/apiError';
import { logError } from '@/shared/utils/errorHandling';
import { createLogger } from '@/shared/utils/logger';
import type { ActivityEvent } from '@/shared/types';

const logger = createLogger('ActivityApiService');

interface ActivityTimelineResponse {
  activities: ActivityEvent[];
  nextCursor: string | null;
  count: number;
}

interface ActivityQueryParams {
  eventType?: string;
  eventTypes?: string[];
  startDate?: string;
  endDate?: string;
  limit?: number;
  cursor?: string;
}

class ActivityApiService {
  async getActivityTimeline(params: ActivityQueryParams = {}): Promise<ActivityTimelineResponse> {
    const result = await httpClient.makeRequest<ActivityTimelineResponse>(
      'edges',
      'get_activity_timeline',
      params
    );

    if (!result.success) {
      logError(result.error, 'fetch activity timeline', { operation: 'get_activity_timeline' });
      throw new ApiError(result.error);
    }

    logger.info(`Fetched ${result.data.count} activity events`);
    return result.data;
  }
}

export const activityApiService = new ActivityApiService();
