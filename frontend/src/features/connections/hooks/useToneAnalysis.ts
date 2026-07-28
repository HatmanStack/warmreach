/* eslint-disable @typescript-eslint/no-unused-vars --
   Community stubs keep the pro signature so the verbatim call sites typecheck,
   and then ignore every argument. Underscore prefixes satisfy tsc's
   noUnusedParameters; this handles ESLint, which has no argsIgnorePattern in
   the shared config. */
// Community edition stub — tone analysis is available in WarmReach Pro.
//
// `analyzeTone` keeps the pro arity: MessageModal.tsx syncs verbatim and calls
// it with four arguments, so a zero-arg stub does not typecheck.
export interface ToneAnalysisResult {
  warmth: number;
  clarity: number;
  pushiness: number;
  suggestions: string[];
}

export function useToneAnalysis() {
  return {
    result: null as ToneAnalysisResult | null,
    isAnalyzing: false,
    error: null as string | null,
    analyzeTone: async (
      _message: string,
      _firstName?: string,
      _position?: string,
      _status?: string
    ) => {},
    clearResult: () => {},
  };
}
