// Reviewed against pro 2026-04-28: source-side TS-correctness fixes do not affect community stub semantics.
// Community edition stub — reply probability is available in WarmReach Pro.
//
// `probabilityMap` carries its pro value type. Untyped, it inferred `{}`, and
// VirtualConnectionList.tsx — which syncs verbatim — indexes it by connection
// id, so the community build failed with TS7053.
export interface ReplyProbabilityEntry {
  replyProbability: number;
  confidence: 'high' | 'medium' | 'low';
}

export function useReplyProbabilities() {
  return {
    probabilityMap: {} as Record<string, ReplyProbabilityEntry | undefined>,
    isLoading: false,
    error: null,
    refetch: async () => {},
  };
}
