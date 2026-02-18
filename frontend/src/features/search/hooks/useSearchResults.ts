import { useCallback, useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import useLocalStorage from '@/hooks/useLocalStorage';
import { useCommand } from '@/shared/hooks';
import type { SearchFormData } from '@/shared/utils/validation';
import { STORAGE_KEYS } from '@/config/appConfig';
import { queryKeys } from '@/shared/lib/queryKeys';
import type { Connection } from '@/shared/types';

interface UseSearchResultsReturn {
  results: string[];
  visitedLinks: Record<string, boolean>;
  loading: boolean;
  error: string | null;
  infoMessage: string | null;
  searchLinkedIn: (searchData: SearchFormData) => Promise<void>;
  markAsVisited: (profileId: string) => void;
  clearResults: () => void;
  clearVisitedLinks: () => void;
}

interface SearchResult {
  response?: Connection[];
  metadata?: {
    totalProfilesAnalyzed?: number;
    goodContactsFound?: number;
    successRate?: string;
  };
}

function useSearchResults(): UseSearchResultsReturn {
  const queryClient = useQueryClient();

  // Local storage for persistence (stays in localStorage - not server state)
  const [results, setResults] = useLocalStorage<string[]>(STORAGE_KEYS.SEARCH_RESULTS, []);

  const [visitedLinks, setVisitedLinks] = useLocalStorage<Record<string, boolean>>(
    STORAGE_KEYS.VISITED_LINKS,
    {}
  );

  // State for informational message from search API
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  const {
    execute,
    status,
    result,
    error: commandError,
    reset,
  } = useCommand<SearchResult>('linkedin:search');

  // Handle command completion
  useEffect(() => {
    if (status === 'completed' && result) {
      setInfoMessage(null);
      // Invalidate connections cache to refetch after search
      queryClient.invalidateQueries({ queryKey: queryKeys.connections.all });
    }
  }, [status, result, queryClient]);

  useEffect(() => {
    if (status === 'failed' && commandError) {
      setInfoMessage(`Search error: ${commandError}`);
    }
  }, [status, commandError]);

  // LinkedIn search via command dispatch to Electron agent
  const searchLinkedIn = useCallback(
    async (searchFormData: SearchFormData) => {
      setInfoMessage(null);
      reset();
      await execute(searchFormData as unknown as Record<string, unknown>);
    },
    [execute, reset]
  );

  // Mark a profile as visited
  const markAsVisited = useCallback(
    (profileId: string) => {
      setVisitedLinks((prev) => ({
        ...prev,
        [profileId]: true,
      }));
    },
    [setVisitedLinks]
  );

  // Clear search results
  const clearResults = useCallback(() => {
    setResults([]);
  }, [setResults]);

  // Clear visited links
  const clearVisitedLinks = useCallback(() => {
    setVisitedLinks({});
  }, [setVisitedLinks]);

  const loading = status === 'dispatching' || status === 'executing';

  return {
    results,
    visitedLinks,
    loading,
    error: commandError,
    infoMessage,
    searchLinkedIn,
    markAsVisited,
    clearResults,
    clearVisitedLinks,
  };
}

export default useSearchResults;
