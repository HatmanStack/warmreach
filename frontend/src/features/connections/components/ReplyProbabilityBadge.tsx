/* eslint-disable @typescript-eslint/no-unused-vars --
   Community stubs keep the pro signature so the verbatim call sites typecheck,
   and then ignore every argument. Underscore prefixes satisfy tsc's
   noUnusedParameters; this handles ESLint, which has no argsIgnorePattern in
   the shared config. */
// Community edition stub — reply probability is available in WarmReach Pro.
// Props mirror the pro component's so the verbatim call sites typecheck.
interface ReplyProbabilityBadgeProps {
  probability: number;
  confidence: 'high' | 'medium' | 'low';
  className?: string;
}

export function ReplyProbabilityBadge(_props: ReplyProbabilityBadgeProps) {
  return null;
}
