import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { httpClient } from '@/shared/utils/httpClient';
import { useAuth } from '@/features/auth';
import { unwrapEnvelope } from '@/shared/utils/apiEnvelope';
import type { LegalDocumentId } from '../documents';

export interface OutstandingDocument {
  documentId: LegalDocumentId;
  title: string;
  version: string;
}

interface LegalStatus {
  outstanding: OutstandingDocument[];
  accepted: Record<string, { version?: string; acceptedAt?: string }>;
  allAccepted: boolean;
}

const EMPTY: LegalStatus = { outstanding: [], accepted: {}, allAccepted: true };

/** Scoped by account: a cached result must not carry across a sign-out. */
export const legalStatusQueryKey = (userId: string | undefined) => [
  'legal-status',
  userId ?? 'anonymous',
];

/** Prefix, for invalidating every account's status. */
export const LEGAL_STATUS_QUERY_KEY = ['legal-status'];

export const useLegalAcceptance = () => {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = (user as { userId?: string; username?: string } | null)?.userId ?? undefined;

  const { data, isLoading, isError, refetch, isFetching } = useQuery<LegalStatus>({
    // Keyed by account. With a shared key, signing out and back in as a
    // different user could reuse the previous account's cached result and
    // suppress the gate for someone who has accepted nothing.
    queryKey: legalStatusQueryKey(userId),
    queryFn: async () => {
      const response = await httpClient.apiClient.post('dynamodb', {
        operation: 'get_legal_status',
      });
      return unwrapEnvelope<LegalStatus>(response.data);
    },
    // The gate is mounted above the router so it can cover any authenticated
    // page, which means it also renders on the landing and sign-in routes.
    // Without this a logged-out visitor fires an unauthenticated request that
    // 401s, and could be shown a legal dialog over the sign-in form.
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const acceptMutation = useMutation({
    mutationFn: async (documentIds: LegalDocumentId[]) => {
      const response = await httpClient.apiClient.post('dynamodb', {
        operation: 'accept_legal_documents',
        documentIds,
      });
      // unwrapEnvelope throws on an error envelope. Returning response.data
      // directly would resolve a failed acceptance as success, hide acceptError,
      // and invalidate the status query as though it had worked — leaving the
      // user past a gate the server still refuses.
      return unwrapEnvelope<{ recorded: unknown[] }>(response.data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: legalStatusQueryKey(userId) });
    },
  });

  // A failed status load must not present as "everything accepted" — that would
  // hide the gate while the server still refuses every LinkedIn action, leaving
  // the user with an unexplained 403. Treat it as nothing outstanding to prompt
  // for, but surface the error so the caller can decide.
  const status = data ?? EMPTY;

  return {
    /** False until signed in — there is no account to hold acceptances for. */
    isAuthenticated: !!user,
    /** Lets the gate offer a retry rather than stranding the user. */
    retry: refetch,
    isFetching,
    outstanding: status.outstanding,
    accepted: status.accepted,
    // Only trust `allAccepted` from a successful load.
    allAccepted: !isError && status.allAccepted,
    isLoading,
    isError,
    accept: acceptMutation.mutate,
    acceptAsync: acceptMutation.mutateAsync,
    isAccepting: acceptMutation.isPending,
    acceptError: acceptMutation.error instanceof Error ? acceptMutation.error : null,
  };
};
