/* eslint-disable @typescript-eslint/no-unused-vars --
   Community stubs keep the pro signature so the verbatim call sites typecheck,
   and then ignore every argument. Underscore prefixes satisfy tsc's
   noUnusedParameters; this handles ESLint, which has no argsIgnorePattern in
   the shared config. */
// Community edition stub — relationship scoring is available in WarmReach Pro.
//
// The props mirror the pro component's. A stub that takes no props does not
// typecheck against the call sites that sync verbatim, which is how the
// community edition's `tsc -b` stayed red without anyone noticing.
import type { ScoreBreakdown } from '@/types';

interface RelationshipStrengthBadgeProps {
  score: number | undefined;
  breakdown?: ScoreBreakdown;
  className?: string;
}

export function RelationshipStrengthBadge(_props: RelationshipStrengthBadgeProps) {
  return null;
}
