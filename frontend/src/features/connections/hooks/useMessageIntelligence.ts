// Reviewed against pro 2026-04-28: source-side TS-correctness fixes do not affect community stub semantics.
// Community edition stub — message intelligence is available in WarmReach Pro.
export function useMessageIntelligence() {
  return {
    stats: null,
    insights: null,
    computedAt: null,
    isLoading: false,
    isAnalyzing: false,
    triggerAnalysis: async () => {},
    refreshStats: async () => {},
  };
}
