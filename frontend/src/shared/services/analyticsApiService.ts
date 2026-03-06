import { httpClient } from '@/shared/utils/httpClient';
import { ApiError } from '@/shared/utils/apiError';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('AnalyticsApiService');

class AnalyticsApiService {
  async getMessagingInsights(forceRecompute = false): Promise<{
    stats: Record<string, unknown>;
    insights: string[] | null;
    computedAt: string;
  }> {
    const result = await httpClient.makeRequest<{
      stats: Record<string, unknown>;
      insights: string[] | null;
      computedAt: string;
    }>('edges', 'get_messaging_insights', { forceRecompute });

    if (!result.success) {
      throw new ApiError(result.error);
    }

    return result.data;
  }

  async analyzeMessagePatterns(
    stats: Record<string, unknown>,
    sampleMessages: Record<string, unknown>[]
  ): Promise<{ insights: string[]; analyzedAt: string }> {
    const result = await httpClient.makeRequest<{ insights: string[]; analyzedAt: string }>(
      'llm',
      'analyze_message_patterns',
      {
        stats,
        sampleMessages,
      }
    );

    if (!result.success) {
      throw new ApiError(result.error);
    }

    return result.data;
  }

  async getAnalyticsDashboard(days = 30): Promise<Record<string, unknown>> {
    const result = await httpClient.makeRequest<Record<string, unknown>>(
      'edges',
      'get_analytics_dashboard',
      { days }
    );

    if (!result.success) {
      throw new ApiError(result.error);
    }

    return result.data;
  }

  async storeMessageInsights(
    insights: string[]
  ): Promise<{ success: boolean; insightsUpdatedAt: string }> {
    const result = await httpClient.makeRequest<{ success: boolean; insightsUpdatedAt: string }>(
      'edges',
      'store_message_insights',
      { insights }
    );

    if (!result.success) {
      throw new ApiError(result.error);
    }

    return result.data;
  }

  async sendLLMRequest(
    operation: string,
    params: Record<string, unknown> = {}
  ): Promise<{
    success: boolean;
    data?: unknown;
    error?: string;
    code?: string;
    operation?: string;
  }> {
    const result = await httpClient.makeRequest<unknown>('llm', operation, params);

    if (!result.success) {
      logger.error('LLM request failed', { error: result.error });
      return {
        success: false,
        error: result.error.message,
        code: result.error.code,
        operation,
      };
    }

    logger.debug('LLM response received', { hasResponse: result.data !== undefined });
    return { success: true, data: result.data };
  }
}

export const analyticsApiService = new AnalyticsApiService();
