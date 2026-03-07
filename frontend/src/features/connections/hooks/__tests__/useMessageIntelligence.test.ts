import { renderHook, act, waitFor } from '@testing-library/react';
import { useMessageIntelligence } from '../useMessageIntelligence';
import { createWrapper } from '@/test-utils';
import { lambdaApiService } from '@/services/lambdaApiService';
import { useTier } from '@/features/tier';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/lambdaApiService');
vi.mock('@/features/tier');

describe('useMessageIntelligence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTier).mockReturnValue({
      isFeatureEnabled: vi.fn().mockReturnValue(true),
    } as any);
  });

  const Wrapper = createWrapper();

  it('should fetch messaging insights when enabled', async () => {
    const mockData = { stats: { totalConnections: 10 }, insights: [], computedAt: 'now' };
    vi.mocked(lambdaApiService.getMessagingInsights).mockResolvedValue(mockData as any);

    const { result } = renderHook(() => useMessageIntelligence(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.stats).toEqual(mockData.stats);
    expect(lambdaApiService.getMessagingInsights).toHaveBeenCalled();
  });

  it('should not fetch when disabled', async () => {
    vi.mocked(useTier).mockReturnValue({
      isFeatureEnabled: vi.fn().mockReturnValue(false),
    } as any);

    const { result } = renderHook(() => useMessageIntelligence(), { wrapper: Wrapper });

    expect(result.current.isLoading).toBe(false);
    expect(lambdaApiService.getMessagingInsights).not.toHaveBeenCalled();
  });

  it('should trigger analysis', async () => {
    const mockData = { stats: { s: 1 }, sampleMessages: [], insights: [], computedAt: 'now' };
    vi.mocked(lambdaApiService.getMessagingInsights).mockResolvedValue(mockData as any);
    vi.mocked(lambdaApiService.analyzeMessagePatterns).mockResolvedValue({
      insights: ['new'],
    } as any);

    const { result } = renderHook(() => useMessageIntelligence(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.stats).toBeDefined();
    });

    await act(async () => {
      await result.current.triggerAnalysis();
    });

    expect(lambdaApiService.analyzeMessagePatterns).toHaveBeenCalled();
    expect(lambdaApiService.storeMessageInsights).toHaveBeenCalledWith(['new']);
  });
});
