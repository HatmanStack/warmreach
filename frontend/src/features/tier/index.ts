/**
 * Community edition tier stubs.
 *
 * All features are enabled, no billing, no quotas. TierProvider wraps children
 * unchanged and every feature gate passes.
 *
 * Billing and tier management are available in WarmReach Pro.
 */

import React, { createContext, useContext, type ReactNode } from 'react';

interface TierContextValue {
  tier: string;
  isFeatureEnabled: (feature: string) => boolean;
  features: Record<string, boolean>;
  quotas: Record<string, unknown>;
  loading: boolean;
  error: null;
}

const ALL_FEATURES: Record<string, boolean> = {
  ai_messaging: true,
  bulk_operations: true,
  advanced_analytics: true,
  priority_support: true,
  deep_research: true,
};

const TierContext = createContext<TierContextValue>({
  tier: 'community',
  isFeatureEnabled: () => true,
  features: ALL_FEATURES,
  quotas: {},
  loading: false,
  error: null,
});

export function TierProvider({ children }: { children: ReactNode }) {
  const value: TierContextValue = {
    tier: 'community',
    isFeatureEnabled: () => true,
    features: ALL_FEATURES,
    quotas: {},
    loading: false,
    error: null,
  };
  return React.createElement(TierContext.Provider, { value }, children);
}

export function useTier(): TierContextValue {
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

export function QuotaUsage() {
  return null;
}

export function useCheckout() {
  return {
    checkout: () => {},
    loading: false,
    error: null,
  };
}
