/**
 * Community edition tier stubs.
 *
 * No billing and no quotas — but NOT "every gate passes". A flag here answers
 * one question: does this edition actually ship a backend for that feature? It
 * used to answer `true` unconditionally, which advertised surfaces the
 * community edition does not have. The concrete cost was a live call to
 * `POST /analytics` on the connections screen, against a Lambda whose source
 * directory is excluded from the sync and which therefore does not exist.
 *
 * Every value below is set from what the community tree contains, and the
 * evidence is in the comment beside it. Two rules follow:
 *   - `isFeatureEnabled` consults this map. Returning `true` for everything
 *     made the map decorative — a flag nobody reads cannot be wrong, and was.
 *   - A flag consulted anywhere in the community tree must appear here, or it
 *     silently reads `false`.
 *
 * Billing and tier management are available in WarmReach Pro.
 */

import React, { createContext, useContext, type ReactNode } from 'react';

/**
 * Interface parity with the pro module's exported context type — same members,
 * same names. Shared test utilities (`src/test-utils/mocks.tsx`, which syncs
 * verbatim) import this by name and build values of it, so it has to match the
 * pro shape exactly; without the export the community tree fails
 * `typecheck:frontend` as soon as the test files are type-checked.
 */
export interface TierContextType {
  tier: string;
  features: Record<string, boolean>;
  quotas: Record<string, unknown>;
  isFeatureEnabled: (feature: string) => boolean;
  loading: boolean;
}

const ALL_FEATURES: Record<string, boolean> = {
  // Served by the community `llm` Lambda AND reachable from a real frontend
  // path in this edition.
  ai_messaging: true, // generate_message
  deep_research: true, // research_selected_ideas / get_research_result / cancel_research

  // The community `llm` handler DOES serve analyze_tone and
  // analyze_message_patterns — but useToneAnalysis and useMessageIntelligence
  // are pure stubs here (`analyzeTone` is a no-op, `stats`/`insights` are always
  // null), so nothing can reach those operations. A backend that can serve an
  // operation is not the same as an edition that ships the feature, and
  // MessageModal.tsx gates a real control on `tone_analysis` — `true` rendered
  // a button that did nothing.
  tone_analysis: false,
  message_intelligence: false,

  // No backend dependency.
  bulk_operations: true,
  priority_support: true,

  // Served by analytics-insights, whose source directory is in
  // .sync/config.json exclude_paths and never reaches this edition.
  advanced_analytics: false,
  relationship_strength_scoring: false,

  // Served by network-intelligence, which this edition does not declare —
  // see the pro-only list in backend/template.yaml. frontend/src/features/network
  // is excluded from the sync too, so there is no surface to enable.
  network_graph_visualization: false,
  warm_intro_paths: false,
};

const isFeatureEnabled = (feature: string): boolean => ALL_FEATURES[feature] === true;

const TierContext = createContext<TierContextType>({
  tier: 'community',
  isFeatureEnabled,
  features: ALL_FEATURES,
  quotas: {},
  loading: false,
});

export function TierProvider({ children }: { children: ReactNode }) {
  const value: TierContextType = {
    tier: 'community',
    isFeatureEnabled,
    features: ALL_FEATURES,
    quotas: {},
    loading: false,
  };
  return React.createElement(TierContext.Provider, { value }, children);
}

export function useTier(): TierContextType {
  return useContext(TierContext);
}

export function FeatureGate({
  children,
}: {
  feature?: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return React.createElement(React.Fragment, null, children);
}

export function UpgradePrompt() {
  return null;
}

export function ProUpgradeChip() {
  // Community edition has all features enabled, so the pro-gate upsell chip is
  // never rendered; stubbed to null for interface parity with the pro tier module.
  return null;
}

export function QuotaUsage() {
  return null;
}

export function useCheckout() {
  return {
    checkout: () => {},
    loading: false,
  };
}
