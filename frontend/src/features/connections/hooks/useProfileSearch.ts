/**
 * useProfileSearch Hook
 *
 * Manages search state, debouncing, and result hydration for profile search.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { searchProfiles } from '@/shared/services/ragstackSearchService';
import { createLogger } from '@/shared/utils/logger';
import type { Connection } from '@/shared/types';

const logger = createLogger('useProfileSearch');

/**
 * Debounce delay in milliseconds
 */
const DEBOUNCE_DELAY = 300;

/**
 * Maximum results to fetch from RAGStack
 */
const MAX_RESULTS = 100;

/**
 * Hook result interface
 */
interface UseProfileSearchResult {
  /** Current search query */
  searchQuery: string;
  /** Function to update search query */
  setSearchQuery: (query: string) => void;
  /** Hydrated search results as Connection objects */
  searchResults: Connection[];
  /** Whether a search is in progress */
  isSearching: boolean;
  /** Error from the last search attempt */
  searchError: Error | null;
  /** Function to clear search and reset state */
  clearSearch: () => void;
  /** Whether search is active (query has content) */
  isSearchActive: boolean;
}

/**
 * Custom hook for profile search with debouncing and result hydration
 *
 * @param allConnections - Array of all available connections to match against
 * @returns Search state and controls
 */
export function useProfileSearch(allConnections: Connection[]): UseProfileSearchResult {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Connection[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<Error | null>(null);

  // Ref to track the current search query for cancellation
  const currentSearchRef = useRef<string | null>(null);
  // Ref for debounce timeout
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Create a map for fast connection lookup by ID
   */
  const connectionMap = useMemo(() => {
    const map = new Map<string, Connection>();
    for (const connection of allConnections) {
      map.set(connection.id, connection);
    }
    return map;
  }, [allConnections]);

  /**
   * Execute the search and hydrate results
   */
  const executeSearch = useCallback(
    async (query: string) => {
      // Mark this as the current search
      currentSearchRef.current = query;
      setIsSearching(true);
      setSearchError(null);

      const startTime = Date.now();

      try {
        logger.debug('Executing search', { queryLength: query.length });

        const response = await searchProfiles(query, MAX_RESULTS);

        // Check if this search is still current (not cancelled by a newer search)
        if (currentSearchRef.current !== query) {
          logger.debug('Search cancelled (superseded by newer search)', {
            queryLength: query.length,
          });
          return;
        }

        // Hydrate results by matching profile IDs to connections
        const hydratedResults: Connection[] = [];
        for (const result of response.results) {
          const connection = connectionMap.get(result.profileId);
          if (connection) {
            hydratedResults.push(connection);
          } else {
            logger.debug('Profile not found in connections', {
              profileId: result.profileId,
            });
          }
        }

        const durationMs = Date.now() - startTime;
        logger.info('Profile search executed', {
          queryLength: query.length,
          resultCount: hydratedResults.length,
          durationMs,
        });

        setSearchResults(hydratedResults);
      } catch (error) {
        // Check if this search is still current
        if (currentSearchRef.current !== query) {
          return;
        }

        const searchError = error instanceof Error ? error : new Error('Search failed');
        logger.error('Profile search failed', {
          query: query.substring(0, 50),
          error: searchError.message,
        });

        setSearchError(searchError);
        setSearchResults([]);
      } finally {
        // Only update loading state if this search is still current
        if (currentSearchRef.current === query) {
          setIsSearching(false);
        }
      }
    },
    [connectionMap]
  );

  /**
   * Handle search query changes with debouncing
   */
  useEffect(() => {
    // Clear any existing debounce timeout
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    }

    // Don't search for empty queries
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      setSearchError(null);
      currentSearchRef.current = null;
      return;
    }

    // Set up debounce
    debounceTimeoutRef.current = setTimeout(() => {
      executeSearch(searchQuery.trim());
    }, DEBOUNCE_DELAY);

    // Cleanup function
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
        debounceTimeoutRef.current = null;
      }
    };
  }, [searchQuery, executeSearch]);

  /**
   * Clear search and reset all state
   */
  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchResults([]);
    setIsSearching(false);
    setSearchError(null);
    currentSearchRef.current = null;

    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    }
  }, []);

  /**
   * Whether search is active (query has content)
   */
  const isSearchActive = searchQuery.trim().length > 0;

  return {
    searchQuery,
    setSearchQuery,
    searchResults,
    isSearching,
    searchError,
    clearSearch,
    isSearchActive,
  };
}
