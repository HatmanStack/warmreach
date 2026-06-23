// Reviewed against pro 2026-06-20: pro-side boundary normalization (removing the
// `as unknown as` casts) does not affect community stub semantics — the stub
// returns the same null/no-op shape.
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
