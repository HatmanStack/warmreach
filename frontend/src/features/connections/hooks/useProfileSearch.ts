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
  // Raw profile ids from the last search (the network layer). Hydration to
  // Connection objects is DERIVED below, so it can re-run cheaply when
  // allConnections finishes loading WITHOUT re-issuing the network search — and
  // so executeSearch no longer closes over the connection map and keeps a stable
  // identity, which stops the debounce effect from re-arming on every
  // allConnections reference change.
  const [rawProfileIds, setRawProfileIds] = useState<string[]>([]);
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
   * Hydrate raw result ids into Connection objects. Re-runs when the results OR
   * the connection set change, so matches fill in if connections finish loading
   * after the search returned.
   */
  const searchResults = useMemo(() => {
    const hydrated: Connection[] = [];
    for (const profileId of rawProfileIds) {
      const connection = connectionMap.get(profileId);
      if (connection) hydrated.push(connection);
    }
    return hydrated;
  }, [rawProfileIds, connectionMap]);

  /**
   * Execute the search (network only). Hydration is derived from rawProfileIds,
   * so this callback does not depend on the connection map and stays stable.
   */
  const executeSearch = useCallback(async (query: string) => {
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

      setRawProfileIds(response.results.map((result) => result.profileId));

      logger.info('Profile search executed', {
        queryLength: query.length,
        resultCount: response.results.length,
        durationMs: Date.now() - startTime,
      });
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
      setRawProfileIds([]);
    } finally {
      // Only update loading state if this search is still current
      if (currentSearchRef.current === query) {
        setIsSearching(false);
      }
    }
  }, []);

  /**
   * Handle search query changes with debouncing
   */
  useEffect(() => {
    // Clear any existing debounce timeout
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    }

    // Don't search for empty queries. Reset via functional updates that keep the
    // SAME reference when already empty, so a re-run can't churn renders.
    if (!searchQuery.trim()) {
      setRawProfileIds((prev) => (prev.length === 0 ? prev : []));
      setIsSearching((prev) => (prev ? false : prev));
      setSearchError((prev) => (prev === null ? prev : null));
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
    setRawProfileIds([]);
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
