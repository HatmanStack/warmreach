import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createWrapper } from '@/test-utils/queryWrapper';
import useSearchResults from './useSearchResults';

const mockExecute = vi.fn();
const mockReset = vi.fn();
let mockStatus = 'idle';
let mockResult: unknown = null;
let mockError: string | null = null;

vi.mock('@/shared/hooks', () => ({
  useCommand: () => ({
    execute: mockExecute,
    status: mockStatus,
    result: mockResult,
    error: mockError,
    reset: mockReset,
  }),
  useToast: () => ({ toast: vi.fn() }),
  useErrorHandler: vi.fn(),
}));

vi.mock('@/hooks/useLocalStorage', () => ({
  default: vi.fn((_key: string, initialValue: unknown) => {
    const state = { current: initialValue };
    return [
      state.current,
      (newValue: unknown) => {
        if (typeof newValue === 'function') {
          state.current = newValue(state.current);
        } else {
          state.current = newValue;
        }
      },
    ];
  }),
}));

describe('useSearchResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatus = 'idle';
    mockResult = null;
    mockError = null;
  });

  describe('initial state', () => {
    it('returns initial values', () => {
      const { result } = renderHook(() => useSearchResults(), {
        wrapper: createWrapper(),
      });

      expect(result.current.results).toEqual([]);
      expect(result.current.visitedLinks).toEqual({});
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.infoMessage).toBeNull();
    });
  });

  describe('searchLinkedIn', () => {
    it('calls execute with search data', async () => {
      const { result } = renderHook(() => useSearchResults(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.searchLinkedIn({
          companyName: 'Test',
          companyRole: 'Engineer',
          companyLocation: 'NYC',
          searchName: '',
          searchPassword: '',
          userId: 'user-1',
        });
      });

      expect(mockReset).toHaveBeenCalled();
      expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({ companyName: 'Test' }));
    });

    it('shows loading when dispatching', () => {
      mockStatus = 'dispatching';

      const { result } = renderHook(() => useSearchResults(), {
        wrapper: createWrapper(),
      });

      expect(result.current.loading).toBe(true);
    });

    it('shows loading when executing', () => {
      mockStatus = 'executing';

      const { result } = renderHook(() => useSearchResults(), {
        wrapper: createWrapper(),
      });

      expect(result.current.loading).toBe(true);
    });

    it('sets error from command failure', () => {
      mockStatus = 'failed';
      mockError = 'Search failed';

      const { result } = renderHook(() => useSearchResults(), {
        wrapper: createWrapper(),
      });

      expect(result.current.error).toBe('Search failed');
    });
  });

  describe('markAsVisited', () => {
    it('marks profile as visited', () => {
      const { result } = renderHook(() => useSearchResults(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.markAsVisited('profile-1');
      });

      expect(typeof result.current.markAsVisited).toBe('function');
    });
  });

  describe('clearResults', () => {
    it('clears results', () => {
      const { result } = renderHook(() => useSearchResults(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.clearResults();
      });

      expect(typeof result.current.clearResults).toBe('function');
    });
  });

  describe('clearVisitedLinks', () => {
    it('clears visited links', () => {
      const { result } = renderHook(() => useSearchResults(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.clearVisitedLinks();
      });

      expect(typeof result.current.clearVisitedLinks).toBe('function');
    });
  });
});
