import { QueryClient, QueryCache, MutationCache } from '@tanstack/react-query';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('queryClient');

/**
 * Pull an HTTP status code off an error if it carries one. Frontend service
 * errors (e.g. ApiError, MessageGenerationError) expose `status`; some libraries
 * use `statusCode`. Returns undefined when the error shape has neither.
 */
function getErrorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const candidate = error as { status?: unknown; statusCode?: unknown };
    if (typeof candidate.status === 'number') return candidate.status;
    if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  }
  return undefined;
}

/**
 * Bounded retry policy: 4xx responses are client errors and are not transient,
 * so retrying them only amplifies load (the retry-storm the audit flagged).
 * Transient errors (5xx / network, i.e. no status) retry up to 2 times (3 attempts total).
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status !== undefined && status >= 400 && status < 500) {
    return false;
  }
  return failureCount < 2;
}

export const queryClient = new QueryClient({
  // Global observability seam: every failed query/mutation is logged in one place
  // so failing endpoints are visible centrally instead of only where a call site
  // happens to render the error.
  queryCache: new QueryCache({
    onError: (error, query) => {
      logger.error('Query error', {
        error,
        queryKey: query.queryKey,
      });
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      logger.error('Mutation error', {
        error,
        mutationKey: mutation.options.mutationKey,
      });
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      gcTime: 30 * 60 * 1000, // 30 minutes (formerly cacheTime)
      retry: shouldRetry,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: 0, // Don't retry mutations by default (non-idempotent operations)
    },
  },
});
