/**
 * Narrow structural contracts for dependencies of LinkedInInteractionService.
 *
 * These duplicate only the subset of methods the facade actually uses, so that
 * the concrete production classes (BrowserSessionManager static class,
 * ConfigManager singleton) can be adapted with named functions instead of
 * `as unknown as` casts at call sites.
 */

import type { Page, ElementHandle } from 'puppeteer';

export interface BrowserSessionManagerContract {
  getInstance(opts: { reinitializeIfUnhealthy: boolean }): Promise<unknown>;
  cleanup(): Promise<void>;
  isSessionHealthy(): Promise<boolean>;
  getHealthStatus(): Promise<Record<string, unknown>>;
  recordError(error: unknown): Promise<void>;
  getBackoffController(): { handleCheckpoint(url: string): Promise<void> } | null;
  getSessionMetrics(): { recordOperation(success: boolean): void } | null;
  lastActivity: Date | null;
}

export interface ConfigManagerContract {
  get(key: string, defaultValue: number): number;
  setOverride(key: string, value: number): void;
  getErrorHandlingConfig(): { retryAttempts: number; retryBaseDelay: number };
}

export interface ControlPlaneServiceContract {
  isConfigured: boolean;
  syncRateLimits(): Promise<{
    linkedin_interactions?: {
      daily_limit?: number | null;
      hourly_limit?: number | null;
    };
  } | null>;
  reportInteraction(operation: string): void;
}

export interface HumanBehaviorContract {
  checkAndApplyCooldown(): Promise<void>;
  simulateHumanMouseMovement(page: Page, element: ElementHandle): Promise<void>;
  recordAction(action: string, data?: Record<string, unknown>): void;
}

/**
 * Adapt the BrowserSessionManager static class (whose methods technically
 * live on the class, not an instance) to the narrow contract. This is the only
 * place the structural coercion happens — every other file uses the contract.
 */
export function asBrowserSessionManagerContract(
  mgr: BrowserSessionManagerContract | object
): BrowserSessionManagerContract {
  // BrowserSessionManager exposes the full method set as static members. The
  // structural compatibility is real; this function names the adaptation so we
  // don't sprinkle `as unknown as` across consumers.
  return mgr as BrowserSessionManagerContract;
}

/**
 * Narrow service instance adapter for any ops context. Each LinkedIn ops
 * module declares its own ``ServiceContext`` interface; the interaction
 * service structurally satisfies the union of them, modulo a few legacy
 * return-type mismatches (``Promise<void>`` vs ``Promise<boolean>``) that
 * predate this refactor. Rather than leave inline ``as unknown as`` casts at
 * every delegation call site, we funnel the adaptation through this function.
 *
 * The generic type parameters give this the appearance of a checked cast, but
 * it is an unchecked ``as unknown as`` escape hatch — hence the ``unsafe``
 * prefix. Only use where the structural compatibility has been verified by
 * inspection; prefer a real adapter (see ``asConfigManagerContract``) when
 * the types are non-trivially different.
 */
export function unsafeAsOpsContext<T extends object, Context>(service: T): Context {
  return service as unknown as Context;
}

/**
 * Adapt a generic ConfigManager instance to the narrow numeric-typed contract.
 * The source methods use `unknown` return types; callers in this facade only
 * ever pass numeric keys, so the narrowing is safe by convention.
 */
export function asConfigManagerContract(cm: {
  get(key: string, defaultValue: unknown): unknown;
  setOverride(key: string, value: unknown): void;
  getErrorHandlingConfig(): Record<string, unknown>;
}): ConfigManagerContract {
  return {
    get(key: string, defaultValue: number): number {
      const raw = cm.get(key, defaultValue);
      return typeof raw === 'number' ? raw : defaultValue;
    },
    setOverride(key: string, value: number): void {
      cm.setOverride(key, value);
    },
    getErrorHandlingConfig(): { retryAttempts: number; retryBaseDelay: number } {
      const raw = cm.getErrorHandlingConfig();
      const retryAttempts = typeof raw.retryAttempts === 'number' ? raw.retryAttempts : 3;
      const retryBaseDelay = typeof raw.retryBaseDelay === 'number' ? raw.retryBaseDelay : 1000;
      return { retryAttempts, retryBaseDelay };
    },
  };
}
