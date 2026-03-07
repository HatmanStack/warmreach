/**
 * Unit tests for useProfileSearch hook
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useProfileSearch } from './useProfileSearch';
import { buildConnection } from '@/test-utils';

// Mock the search service
const mockSearchProfiles = vi.fn();

vi.mock('@/shared/services/ragstackSearchService', () => ({
  searchProfiles: (...args: unknown[]) => mockSearchProfiles(...args),
}));

// Mock logger
vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('useProfileSearch', () => {
  const mockConnections = [
    buildConnection({
      id: 'abc123' as any,
      first_name: 'John',
      last_name: 'Doe',
      position: 'Software Engineer',
      company: 'TechCorp',
      status: 'ally',
    }),
    buildConnection({
      id: 'def456' as any,
      first_name: 'Jane',
      last_name: 'Smith',
      position: 'Product Manager',
      company: 'DataCo',
      status: 'ally',
    }),
    buildConnection({
      id: 'ghi789' as any,
      first_name: 'Bob',
      last_name: 'Wilson',
      position: 'Designer',
      company: 'DesignHub',
      status: 'ally',
    }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should initialize with default values', () => {
    const { result } = renderHook(() => useProfileSearch(mockConnections));

    expect(result.current.searchQuery).toBe('');
    expect(result.current.searchResults).toEqual([]);
    expect(result.current.isSearching).toBe(false);
    expect(result.current.searchError).toBeNull();
    expect(result.current.isSearchActive).toBe(false);
  });

  it('should set search query', () => {
    const { result } = renderHook(() => useProfileSearch(mockConnections));

    act(() => {
      result.current.setSearchQuery('engineer');
    });

    expect(result.current.searchQuery).toBe('engineer');
    expect(result.current.isSearchActive).toBe(true);
  });

  it('should debounce search queries', async () => {
    mockSearchProfiles.mockResolvedValue({
      results: [{ profileId: 'abc123', score: 0.95, snippet: '' }],
      totalResults: 1,
    });

    const { result } = renderHook(() => useProfileSearch(mockConnections));

    act(() => {
      result.current.setSearchQuery('e');
    });
    act(() => {
      result.current.setSearchQuery('en');
    });
    act(() => {
      result.current.setSearchQuery('eng');
    });
    act(() => {
      result.current.setSearchQuery('engineer');
    });

    // Should not have called search yet
    expect(mockSearchProfiles).not.toHaveBeenCalled();

    // Fast forward past debounce delay and flush promises
    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve(); // Let microtasks run
    });

    // Only one search after debounce
    expect(mockSearchProfiles).toHaveBeenCalledTimes(1);
    expect(mockSearchProfiles).toHaveBeenCalledWith('engineer', 100);
  });

  it('should hydrate results from connections', async () => {
    mockSearchProfiles.mockResolvedValue({
      results: [{ profileId: 'abc123', score: 0.9, snippet: '' }],
      totalResults: 1,
    });

    const { result } = renderHook(() => useProfileSearch(mockConnections));

    act(() => {
      result.current.setSearchQuery('john');
    });

    // Advance timers and wait for the search to complete
    await act(async () => {
      vi.advanceTimersByTime(350);
      // Flush all pending promises
      await vi.runAllTimersAsync();
    });

    expect(result.current.searchResults.length).toBe(1);
    expect(result.current.searchResults[0].first_name).toBe('John');
  });

  it('should clear search', async () => {
    mockSearchProfiles.mockResolvedValue({
      results: [{ profileId: 'abc123', score: 0.9, snippet: '' }],
      totalResults: 1,
    });

    const { result } = renderHook(() => useProfileSearch(mockConnections));

    // Set up search
    act(() => {
      result.current.setSearchQuery('john');
    });

    await act(async () => {
      vi.advanceTimersByTime(350);
      await vi.runAllTimersAsync();
    });

    // Clear search
    act(() => {
      result.current.clearSearch();
    });

    expect(result.current.searchQuery).toBe('');
    expect(result.current.searchResults).toEqual([]);
    expect(result.current.isSearchActive).toBe(false);
  });

  it('should set isSearching during API call', async () => {
    let resolveSearch: (value: unknown) => void;
    mockSearchProfiles.mockReturnValue(
      new Promise((resolve) => {
        resolveSearch = resolve;
      })
    );

    const { result } = renderHook(() => useProfileSearch(mockConnections));

    act(() => {
      result.current.setSearchQuery('test');
    });

    await act(async () => {
      vi.advanceTimersByTime(350);
      // Let the search start
      await Promise.resolve();
    });

    // Should be searching
    expect(result.current.isSearching).toBe(true);

    // Resolve the search
    await act(async () => {
      resolveSearch!({
        results: [],
        totalResults: 0,
      });
      await Promise.resolve();
    });

    expect(result.current.isSearching).toBe(false);
  });

  it('should handle search errors', async () => {
    const searchError = new Error('Search failed');
    mockSearchProfiles.mockRejectedValue(searchError);

    const { result } = renderHook(() => useProfileSearch(mockConnections));

    act(() => {
      result.current.setSearchQuery('test');
    });

    await act(async () => {
      vi.advanceTimersByTime(350);
      await vi.runAllTimersAsync();
    });

    expect(result.current.searchError).not.toBeNull();
    expect(result.current.isSearching).toBe(false);
  });

  it('should preserve relevance ordering', async () => {
    mockSearchProfiles.mockResolvedValue({
      results: [
        { profileId: 'def456', score: 0.95, snippet: '' },
        { profileId: 'abc123', score: 0.85, snippet: '' },
      ],
      totalResults: 2,
    });

    const { result } = renderHook(() => useProfileSearch(mockConnections));

    act(() => {
      result.current.setSearchQuery('engineer');
    });

    await act(async () => {
      vi.advanceTimersByTime(350);
      await vi.runAllTimersAsync();
    });

    expect(result.current.searchResults.length).toBe(2);
    // First result should be Jane (def456) with higher score
    expect(result.current.searchResults[0].first_name).toBe('Jane');
    // Second result should be John (abc123) with lower score
    expect(result.current.searchResults[1].first_name).toBe('John');
  });

  it('should cancel pending search on new input', async () => {
    let resolveFirst: (value: unknown) => void;
    let callCount = 0;

    mockSearchProfiles.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({
        results: [{ profileId: 'abc123', score: 0.9, snippet: '' }],
        totalResults: 1,
      });
    });

    const { result } = renderHook(() => useProfileSearch(mockConnections));

    // First search
    act(() => {
      result.current.setSearchQuery('first');
    });

    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve();
    });

    // First search should have started
    expect(mockSearchProfiles).toHaveBeenCalledTimes(1);

    // Second search while first is pending
    act(() => {
      result.current.setSearchQuery('second');
    });

    await act(async () => {
      vi.advanceTimersByTime(350);
      await vi.runAllTimersAsync();
    });

    // Second search should have completed
    expect(mockSearchProfiles).toHaveBeenCalledTimes(2);

    // Resolve first search (should be ignored)
    await act(async () => {
      resolveFirst!({
        results: [{ profileId: 'def456', score: 0.9, snippet: '' }],
        totalResults: 1,
      });
      await Promise.resolve();
    });

    // Should have the result from the second search (abc123)
    expect(result.current.searchResults.length).toBe(1);
    expect(result.current.searchResults[0].first_name).toBe('John');
  });

  it('should not search when query is empty', async () => {
    const { result } = renderHook(() => useProfileSearch(mockConnections));

    act(() => {
      result.current.setSearchQuery('');
    });

    await act(async () => {
      vi.advanceTimersByTime(350);
    });

    expect(mockSearchProfiles).not.toHaveBeenCalled();
  });
});
