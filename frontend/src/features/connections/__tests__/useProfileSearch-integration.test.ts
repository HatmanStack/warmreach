import { renderHook, waitFor, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server, createAuthenticatedWrapper, buildConnection } from '@/test-utils';
import { useProfileSearch } from '../hooks/useProfileSearch';
import { describe, it, expect, vi } from 'vitest';

describe('useProfileSearch (integration)', () => {
  const mockConnections = [
    buildConnection({ id: 'p1', first_name: 'Engineer', last_name: 'One' }),
    buildConnection({ id: 'p2', first_name: 'Designer', last_name: 'Two' }),
  ];

  it('should return search results from API hydrated with connections', async () => {
    server.use(
      http.post('*/ragstack', () => {
        return HttpResponse.json({
          results: [{ source: 'p1', score: 0.9, content: 'Engineer' }],
          totalResults: 1,
        });
      })
    );

    const { result } = renderHook(() => useProfileSearch(mockConnections), {
      wrapper: createAuthenticatedWrapper(),
    });

    act(() => {
      result.current.setSearchQuery('engineer');
    });

    // Wait for debounce and API call and hydration
    await waitFor(
      () => {
        expect(result.current.searchResults).toHaveLength(1);
      },
      { timeout: 2000 }
    );

    expect(result.current.searchResults[0].id).toBe('p1');
    expect(result.current.isSearchActive).toBe(true);
  });

  it('should handle API errors gracefully', async () => {
    server.use(
      http.post('*/ragstack', () => {
        return new HttpResponse(JSON.stringify({ error: 'Internal error' }), { status: 500 });
      })
    );

    const { result } = renderHook(() => useProfileSearch(mockConnections), {
      wrapper: createAuthenticatedWrapper(),
    });

    act(() => {
      result.current.setSearchQuery('fail');
    });

    await waitFor(
      () => {
        expect(result.current.isSearching).toBe(false);
      },
      { timeout: 2000 }
    );

    expect(result.current.searchError).toBeDefined();
    expect(result.current.searchResults).toHaveLength(0);
  });

  it('should handle empty results from API', async () => {
    server.use(
      http.post('*/ragstack', () => {
        return HttpResponse.json({
          results: [],
          totalResults: 0,
        });
      })
    );

    const { result } = renderHook(() => useProfileSearch(mockConnections), {
      wrapper: createAuthenticatedWrapper(),
    });

    act(() => {
      result.current.setSearchQuery('nothing');
    });

    await waitFor(
      () => {
        expect(result.current.isSearching).toBe(false);
      },
      { timeout: 2000 }
    );

    expect(result.current.searchResults).toHaveLength(0);
  });

  it('should debounce multiple searches', async () => {
    const searchSpy = vi.fn();
    server.use(
      http.post('*/ragstack', () => {
        searchSpy();
        return HttpResponse.json({ results: [], totalResults: 0 });
      })
    );

    const { result } = renderHook(() => useProfileSearch(mockConnections), {
      wrapper: createAuthenticatedWrapper(),
    });

    act(() => {
      result.current.setSearchQuery('e');
    });
    act(() => {
      result.current.setSearchQuery('en');
    });
    act(() => {
      result.current.setSearchQuery('eng');
    });

    // Wait for debounce period
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    await waitFor(
      () => {
        expect(result.current.isSearching).toBe(false);
      },
      { timeout: 2000 }
    );

    expect(searchSpy).toHaveBeenCalledTimes(1);
  });

  it('should cancel previous search when new query is entered during debounce', async () => {
    const searchSpy = vi.fn();
    server.use(
      http.post('*/ragstack', () => {
        searchSpy();
        return HttpResponse.json({
          results: [{ source: 'p1', score: 0.9, content: 'Test' }],
          totalResults: 1,
        });
      })
    );

    const { result } = renderHook(() => useProfileSearch(mockConnections), {
      wrapper: createAuthenticatedWrapper(),
    });

    // Set first query, then immediately replace before debounce fires
    act(() => {
      result.current.setSearchQuery('first');
    });
    // Replace within debounce window (300ms) — first query should never fire
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      result.current.setSearchQuery('second');
    });

    // Wait for debounce + API response
    await waitFor(
      () => {
        expect(result.current.isSearching).toBe(false);
        expect(result.current.searchResults).toHaveLength(1);
      },
      { timeout: 2000 }
    );

    // Only one API call should have been made (for 'second', not 'first')
    expect(searchSpy).toHaveBeenCalledTimes(1);
  });
});
