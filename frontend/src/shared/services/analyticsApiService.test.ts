import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyticsApiService } from './analyticsApiService';
import { httpClient } from '@/shared/utils/httpClient';
import { ApiError } from '@/shared/utils/apiError';

vi.mock('@/shared/utils/httpClient', () => ({
  httpClient: {
    makeRequest: vi.fn(),
  },
}));

describe('AnalyticsApiService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getMessagingInsights', () => {
    it('should fetch messaging insights', async () => {
      const mockData = { stats: {}, insights: [], computedAt: 'now' };
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: mockData,
      });

      const result = await analyticsApiService.getMessagingInsights();

      expect(httpClient.makeRequest).toHaveBeenCalledWith('analytics', 'get_messaging_insights', {
        forceRecompute: false,
      });
      expect(result).toEqual(mockData);
    });

    it('should throw ApiError on failure', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: false,
        error: 'Server error',
        data: null,
      });

      await expect(analyticsApiService.getMessagingInsights()).rejects.toThrow(ApiError);
    });
  });

  describe('analyzeMessagePatterns', () => {
    it('should call LLM endpoint', async () => {
      const mockData = { insights: ['good'], analyzedAt: 'now' };
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: mockData,
      });

      const result = await analyticsApiService.analyzeMessagePatterns({}, []);

      expect(httpClient.makeRequest).toHaveBeenCalledWith('llm', 'analyze_message_patterns', {
        stats: {},
        sampleMessages: [],
      });
      expect(result).toEqual(mockData);
    });
  });

  describe('getAnalyticsDashboard', () => {
    it('should fetch dashboard data', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: { summary: 'ok' },
      });

      const result = await analyticsApiService.getAnalyticsDashboard(7);

      expect(httpClient.makeRequest).toHaveBeenCalledWith('analytics', 'get_analytics_dashboard', {
        days: 7,
      });
      expect(result).toEqual({ summary: 'ok' });
    });
  });

  describe('storeMessageInsights', () => {
    it('should store insights and return update info', async () => {
      const mockData = { success: true, insightsUpdatedAt: '2024-01-01' };
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: mockData,
      });

      const result = await analyticsApiService.storeMessageInsights(['new insight']);

      expect(httpClient.makeRequest).toHaveBeenCalledWith('analytics', 'store_message_insights', {
        insights: ['new insight'],
      });
      expect(result).toEqual(mockData);
    });

    it('should throw ApiError on failure', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: false,
        error: { message: 'Write failed' },
        data: null,
      });

      await expect(analyticsApiService.storeMessageInsights([])).rejects.toThrow(ApiError);
    });
  });

  describe('sendLLMRequest', () => {
    it('should send generic LLM request', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: 'response',
      });

      const result = await analyticsApiService.sendLLMRequest('tone_analysis', { text: 'hi' });

      expect(httpClient.makeRequest).toHaveBeenCalledWith('llm', 'tone_analysis', { text: 'hi' });
      expect(result).toEqual({ success: true, data: 'response' });
    });

    it('should handle LLM request failure gracefully', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: false,
        error: { message: 'Too many requests', code: 'RATE_LIMIT' },
        data: null,
      });

      const result = await analyticsApiService.sendLLMRequest('op');

      expect(result.success).toBe(false);
      expect(result.code).toBe('RATE_LIMIT');
    });
  });
});
