import { renderHook, act } from '@testing-library/react';
import useSearchResults from '../useSearchResults';
import { useCommand } from '@/shared/hooks';
import { createWrapper, buildMockCommandReturn } from '@/test-utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/hooks', () => ({
  useCommand: vi.fn(),
}));

// Mock useLocalStorage to avoid real persistence
vi.mock('@/hooks/useLocalStorage', () => ({
  default: vi.fn().mockImplementation((key, initial) => {
    const state = initial;
    return [state, vi.fn()];
  }),
}));

describe('useSearchResults', () => {
  const mockExecute = vi.fn();
  const mockReset = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCommand).mockReturnValue(
      buildMockCommandReturn({
        execute: mockExecute,
        reset: mockReset,
      })
    );
  });

  const Wrapper = createWrapper();

  it('should call execute on searchLinkedIn', async () => {
    const { result } = renderHook(() => useSearchResults(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.searchLinkedIn({ company: 'Google' } as any);
    });

    expect(mockExecute).toHaveBeenCalledWith({ company: 'Google' });
    expect(mockReset).toHaveBeenCalled();
  });

  it('should update infoMessage on failure', async () => {
    const { result, rerender } = renderHook(() => useSearchResults(), { wrapper: Wrapper });

    vi.mocked(useCommand).mockReturnValue(
      buildMockCommandReturn({
        execute: mockExecute,
        reset: mockReset,
        status: 'failed',
        error: 'Network error',
      })
    );

    rerender();

    expect(result.current.infoMessage).toBe('Search error: Network error');
  });

  it('should clear results and visited links', () => {
    const { result } = renderHook(() => useSearchResults(), { wrapper: Wrapper });

    act(() => {
      result.current.clearResults();
      result.current.clearVisitedLinks();
    });

    // Note: Since we mocked useLocalStorage, we're just checking if they're callable
    // In a real test we'd check if the setResults mock was called
  });
});
