// Reviewed against pro 2026-04-28: source-side TS-correctness fixes do not affect community stub semantics.
// Community edition stub — reply probability is available in WarmReach Pro.
export function useReplyProbabilities() {
  return {
    probabilityMap: {},
    isLoading: false,
    error: null,
    refetch: async () => {},
  };
}
