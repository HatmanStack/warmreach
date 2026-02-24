import { httpClient } from '@/shared/utils/httpClient';
import { ApiError } from '@/shared/utils/apiError';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('AnalyticsApiService');

export class AnalyticsApiService {
    async getMessagingInsights(forceRecompute = false): Promise<{
        stats: Record<string, unknown>;
        insights: string[] | null;
        computedAt: string;
    }> {
        return httpClient.makeRequest('edges', 'get_messaging_insights', { forceRecompute });
    }

    async analyzeMessagePatterns(
        stats: Record<string, unknown>,
        sampleMessages: Record<string, unknown>[]
    ): Promise<{ insights: string[]; analyzedAt: string }> {
        return httpClient.makeRequest('llm', 'analyze_message_patterns', {
            stats,
            sampleMessages,
        });
    }

    async getAnalyticsDashboard(days = 30): Promise<Record<string, unknown>> {
        return httpClient.makeRequest('edges', 'get_analytics_dashboard', { days });
    }

    async storeMessageInsights(
        insights: string[]
    ): Promise<{ success: boolean; insightsUpdatedAt: string }> {
        return httpClient.makeRequest('edges', 'store_message_insights', { insights });
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
        try {
            const response = await httpClient.makeRequest<unknown>('llm', operation, params);
            logger.debug('LLM response received', { hasResponse: response !== undefined });
            return { success: true, data: response };
        } catch (error) {
            logger.error('LLM request failed', { error });

            if (error instanceof ApiError) {
                if (error.status === 429 || error.code === 'QUOTA_EXCEEDED') {
                    return {
                        success: false,
                        error: error.message || 'limit reached',
                        code: 'QUOTA_EXCEEDED',
                        operation,
                    };
                }
                return { success: false, error: error.message, code: error.code };
            }

            return { success: false, error: 'Failed to execute LLM operation' };
        }
    }
}

export const analyticsApiService = new AnalyticsApiService();
