import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { lambdaApiService } from '@/shared/services';
import { useAuth } from '@/features/auth';
import { queryKeys } from '@/shared/lib/queryKeys';
import type { Connection, ConnectionStatus } from '@/shared/types';

export const useConnections = (filters?: { status?: string; tags?: string[]; limit?: number }) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Build the full query key including filters for cache operations
  const fullQueryKey = [queryKeys.connections.byUser(user?.id ?? ''), filters];

  // Query for fetching connections via Lambda API (DynamoDB)
  const {
    data: connections = [],
    isLoading: loading,
    error,
    refetch,
  } = useQuery({
    queryKey: fullQueryKey,
    queryFn: async () => {
      const statusFilter = filters?.status as ConnectionStatus | undefined;
      return await lambdaApiService.getConnectionsByStatus(statusFilter);
    },
    enabled: !!user,
  });

  // Mutation for updating connection status
  const updateMutation = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<Connection> }) =>
      lambdaApiService.updateConnectionStatus(id, updates.status as ConnectionStatus, {
        profileId: id,
      }),
    onSuccess: (_, { id, updates }) => {
      queryClient.setQueryData(fullQueryKey, (old: Connection[] = []) =>
        old.map((conn) => (conn.id === id ? { ...conn, ...updates } : conn))
      );
    },
  });

  const createConnection = async (): Promise<boolean> => {
    // Connection creation happens via search/profile-init commands, not direct CRUD
    return false;
  };

  const updateConnection = async (
    connectionId: string,
    updates: Partial<Connection>
  ): Promise<boolean> => {
    try {
      await updateMutation.mutateAsync({ id: connectionId, updates });
      return true;
    } catch {
      return false;
    }
  };

  return {
    connections,
    loading,
    error: error?.message ?? null,
    refetch,
    createConnection,
    updateConnection,
  };
};
