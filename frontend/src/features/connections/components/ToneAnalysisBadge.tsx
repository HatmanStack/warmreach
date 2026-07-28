/* eslint-disable @typescript-eslint/no-unused-vars --
   Community stubs keep the pro signature so the verbatim call sites typecheck,
   and then ignore every argument. Underscore prefixes satisfy tsc's
   noUnusedParameters; this handles ESLint, which has no argsIgnorePattern in
   the shared config. */
// Community edition stub — tone analysis is available in WarmReach Pro.
// Props mirror the pro component's so the verbatim call sites typecheck.
import type { ToneAnalysisResult } from '../hooks/useToneAnalysis';

interface ToneAnalysisBadgeProps {
  result: ToneAnalysisResult;
  onClose: () => void;
}

export function ToneAnalysisBadge(_props: ToneAnalysisBadgeProps) {
  return null;
}
