import { useState, useCallback, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/features/auth';
import { useTier } from '@/features/tier';
import { useToast } from '@/shared/hooks';
import { lambdaApiService as dbConnector, ApiError } from '@/shared/services';
import { queryKeys } from '@/shared/lib/queryKeys';
import type { Connection, StatusValue, ConnectionCounts, ConnectionStatus } from '@/types';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('useConnectionsManager');

export function useConnectionsManager() {
  const { user } = useAuth();
  const { isFeatureEnabled } = useTier();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const scoringTriggered = useRef(false);

  // Local UI state (not server state)
  const [selectedStatus, setSelectedStatus] = useState<StatusValue>('all');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [selectedConnections, setSelectedConnections] = useState<string[]>([]);

  // Server state via React Query
  const {
    data: connections = [],
    isLoading: connectionsLoading,
    error: connectionsError,
    refetch: fetchConnections,
  } = useQuery({
    queryKey: queryKeys.connections.byUser(user?.id ?? ''),
    queryFn: async () => {
      const fetchedConnections = await dbConnector.getConnectionsByStatus();
      logger.info('Connections fetched successfully', { count: fetchedConnections.length });
      // Trigger scoring for pro users (fire-and-forget, non-blocking)
      if (isFeatureEnabled('relationship_strength_scoring') && !scoringTriggered.current) {
        scoringTriggered.current = true;
        dbConnector
          .computeRelationshipScores()
          .then(() => new Promise((r) => setTimeout(r, 2000)))
          .then(() => {
            queryClient.invalidateQueries({
              queryKey: queryKeys.connections.byUser(user?.id ?? ''),
            });
          })
          .catch((err) => {
            logger.debug('Score computation failed (non-blocking)', { error: err });
          });
      }
      return fetchedConnections;
    },
    enabled: !!user,
    staleTime: 2 * 60 * 1000, // 2 minutes
  });

  // Calculate connection counts (derived state)
  const connectionCounts = useMemo((): ConnectionCounts => {
    const counts = { incoming: 0, outgoing: 0, ally: 0, total: 0 };
    connections.forEach((connection) => {
      switch (connection.status) {
        case 'incoming':
          counts.incoming++;
          break;
        case 'outgoing':
          counts.outgoing++;
          break;
        case 'ally':
          counts.ally++;
          break;
      }
    });
    counts.total = counts.incoming + counts.outgoing + counts.ally;
    return counts;
  }, [connections]);

  // Exported for backwards compatibility
  const calculateConnectionCounts = useCallback((conns: Connection[]): ConnectionCounts => {
    const counts = { incoming: 0, outgoing: 0, ally: 0, total: 0 };
    conns.forEach((connection) => {
      switch (connection.status) {
        case 'incoming':
          counts.incoming++;
          break;
        case 'outgoing':
          counts.outgoing++;
          break;
        case 'ally':
          counts.ally++;
          break;
      }
    });
    counts.total = counts.incoming + counts.outgoing + counts.ally;
    return counts;
  }, []);

  // Filter connections by status and tags
  const filteredConnections = useMemo(() => {
    let list = connections.filter((connection) => {
      if (selectedStatus === 'all')
        return ['incoming', 'outgoing', 'ally'].includes(connection.status);
      return connection.status === selectedStatus;
    });

    if (activeTags.length > 0) {
      list = [...list].sort((a, b) => {
        const aTagsMatch = (a.tags || a.common_interests || []).filter((t: string) =>
          activeTags.includes(t)
        ).length;
        const bTagsMatch = (b.tags || b.common_interests || []).filter((t: string) =>
          activeTags.includes(t)
        ).length;
        if (aTagsMatch !== bTagsMatch) return bTagsMatch - aTagsMatch;
        return `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`);
      });
    }
    return list;
  }, [connections, selectedStatus, activeTags]);

  // Get "possible" connections (new connections)
  const newConnections = useMemo(() => {
    return connections.filter((connection) => connection.status === 'possible');
  }, [connections]);

  // Selection count
  const selectedConnectionsCount = useMemo(() => selectedConnections.length, [selectedConnections]);

  // Actions
  const handleTagClick = useCallback((tag: string) => {
    setActiveTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }, []);

  const toggleConnectionSelection = useCallback((connectionId: string) => {
    setSelectedConnections((prev) =>
      prev.includes(connectionId)
        ? prev.filter((id) => id !== connectionId)
        : [...prev, connectionId]
    );
  }, []);

  const handleConnectionCheckboxChange = useCallback((connectionId: string, checked: boolean) => {
    setSelectedConnections((prev) => {
      if (checked) return prev.includes(connectionId) ? prev : [...prev, connectionId];
      return prev.filter((id) => id !== connectionId);
    });
  }, []);

  const updateConnectionStatus = useCallback(
    (connectionId: string, newStatus: ConnectionStatus) => {
      // Optimistic update via React Query cache
      queryClient.setQueryData(
        queryKeys.connections.byUser(user?.id ?? ''),
        (old: Connection[] = []) =>
          old.map((c) => (c.id === connectionId ? { ...c, status: newStatus } : c))
      );
    },
    [queryClient, user?.id]
  );

  // Compute relationship scores for pro users (fire-and-forget, once per session)
  const computeScores = useCallback(async () => {
    if (!isFeatureEnabled('relationship_strength_scoring')) return;
    if (scoringTriggered.current) return;
    scoringTriggered.current = true;
    try {
      await dbConnector.computeRelationshipScores();
      // Brief delay to let DynamoDB writes propagate before re-fetching
      await new Promise((r) => setTimeout(r, 2000));
      queryClient.invalidateQueries({ queryKey: queryKeys.connections.byUser(user?.id ?? '') });
    } catch (err) {
      logger.debug('Score computation failed (non-blocking)', { error: err });
    }
  }, [isFeatureEnabled, queryClient, user?.id]);

  // Wrapper to handle refetch with error handling (matches original API)
  const fetchConnectionsWithErrorHandling = useCallback(async () => {
    try {
      const result = await fetchConnections({ throwOnError: true });
      if (result.error) {
        throw result.error;
      }
    } catch (err: unknown) {
      logger.error('Error fetching connections', { error: err });
      const errorMessage = err instanceof ApiError ? err.message : 'Failed to fetch connections';
      toast({
        title: 'Failed to Load Connections',
        description: errorMessage,
        variant: 'destructive',
      });
    }
  }, [fetchConnections, toast]);

  return {
    connections,
    connectionsLoading,
    connectionsError:
      connectionsError instanceof Error
        ? connectionsError.message
        : connectionsError
          ? String(connectionsError)
          : null,
    selectedStatus,
    setSelectedStatus,
    activeTags,
    connectionCounts,
    selectedConnections,
    filteredConnections,
    newConnections,
    selectedConnectionsCount,
    fetchConnections: fetchConnectionsWithErrorHandling,
    handleTagClick,
    toggleConnectionSelection,
    handleConnectionCheckboxChange,
    updateConnectionStatus,
    calculateConnectionCounts,
    computeScores,
  };
}
