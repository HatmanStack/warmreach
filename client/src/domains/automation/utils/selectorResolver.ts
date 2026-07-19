import type { Page, ElementHandle } from 'puppeteer';
import { SelectorRegistry, SelectorStrategy } from './selectorRegistry.js';
import { logger } from '#utils/logger.js';

export class SelectorNotFoundError extends Error {
  public interactionPoint: string;
  public attemptedStrategies: SelectorStrategy[];

  constructor(interactionPoint: string, attemptedStrategies: SelectorStrategy[]) {
    super(`Selector not found for interaction point: ${interactionPoint}`);
    this.name = 'SelectorNotFoundError';
    this.interactionPoint = interactionPoint;
    this.attemptedStrategies = attemptedStrategies;
  }
}

/**
 * Per-interaction-point resolution health, surfaced by {@link
 * SelectorResolver.getSelectorHealthReport}. Makes DOM drift visible *before* a
 * cascade runs out of fallbacks: if `promotedStrategy` is set, the canonical
 * `preferredStrategy` selector has stopped matching in the wild.
 */
export interface SelectorHealth {
  interactionPoint: string;
  /** The cascade's canonical first strategy (registry index 0). */
  preferredStrategy: string;
  /** Strategy auto-promoted to the front (last-working); null = still preferred. */
  promotedStrategy: string | null;
  /** Successful-match count keyed by strategy name. */
  matchesByStrategy: Record<string, number>;
  /** Matches served by a strategy other than the canonical preferred one. */
  fallbackMatches: number;
  /** Times every strategy in the cascade missed on a required resolution. */
  failures: number;
  lastMatchedStrategy: string | null;
  lastMatchedAt: string | null;
  lastFailureAt: string | null;
}

export class SelectorResolver {
  /** Consecutive matches by one fallback strategy required before auto-promoting it. */
  private static readonly PROMOTION_THRESHOLD = 3;

  /** interactionPoint -> accumulated resolution health. */
  private health = new Map<string, SelectorHealth>();
  /** interactionPoint -> strategy name auto-promoted to the front of the cascade. */
  private promotions = new Map<string, string>();
  /** interactionPoint -> current run of consecutive matches by a single fallback strategy. */
  private _fallbackStreak = new Map<string, { strategy: string; count: number }>();

  constructor(private registry: SelectorRegistry) {}

  /**
   * The cascade for an interaction point, reordered so a previously-promoted
   * (last-working) strategy is tried first. Non-destructive: the registry array
   * is never mutated, so the canonical order is preserved for drift reporting
   * and the promotion overlay stays isolated to this resolver instance.
   */
  private _ordered(interactionPoint: string, cascade: SelectorStrategy[]): SelectorStrategy[] {
    const promoted = this.promotions.get(interactionPoint);
    if (!promoted) return cascade;
    const idx = cascade.findIndex((s) => s.strategy === promoted);
    if (idx <= 0) return cascade; // absent, or already first
    const reordered = [...cascade];
    const [hit] = reordered.splice(idx, 1);
    reordered.unshift(hit!);
    return reordered;
  }

  private _healthFor(interactionPoint: string, cascade: SelectorStrategy[]): SelectorHealth {
    let entry = this.health.get(interactionPoint);
    if (!entry) {
      entry = {
        interactionPoint,
        preferredStrategy: cascade[0]?.strategy ?? '(none)',
        promotedStrategy: null,
        matchesByStrategy: {},
        fallbackMatches: 0,
        failures: 0,
        lastMatchedStrategy: null,
        lastMatchedAt: null,
        lastFailureAt: null,
      };
      this.health.set(interactionPoint, entry);
    }
    return entry;
  }

  /**
   * Record which strategy satisfied an interaction point. When the winner is not
   * the cascade's canonical preferred strategy, the preferred selector has
   * drifted: promote the winner so subsequent resolves try it first, and log the
   * transition once so DOM drift is visible before the cascade exhausts.
   */
  private _recordMatch(
    interactionPoint: string,
    cascade: SelectorStrategy[],
    strategyObj: SelectorStrategy
  ): void {
    const entry = this._healthFor(interactionPoint, cascade);
    const name = strategyObj.strategy;
    entry.matchesByStrategy[name] = (entry.matchesByStrategy[name] ?? 0) + 1;
    entry.lastMatchedStrategy = name;
    entry.lastMatchedAt = new Date().toISOString();

    const preferred = this.registry[interactionPoint]?.[0]?.strategy;
    if (!preferred) return;

    if (name === preferred) {
      // The canonical selector matched again — demote any earlier promotion and
      // reset the streak so a stale promotion can't outlive the drift that
      // justified it. When a promoted strategy misses, the resolve loop falls
      // through to the preferred; its match here is what reclaims the front.
      if (this.promotions.delete(interactionPoint)) {
        entry.promotedStrategy = null;
      }
      this._fallbackStreak.delete(interactionPoint);
      return;
    }

    // A non-preferred strategy won. Require SUSTAINED evidence (a run of matches
    // by the same fallback) before reordering the cascade, so a single fluke
    // match can't permanently promote a worse selector ahead of the preferred.
    entry.fallbackMatches += 1;
    const streak = this._fallbackStreak.get(interactionPoint);
    const count = streak && streak.strategy === name ? streak.count + 1 : 1;
    this._fallbackStreak.set(interactionPoint, { strategy: name, count });

    if (
      count >= SelectorResolver.PROMOTION_THRESHOLD &&
      this.promotions.get(interactionPoint) !== name
    ) {
      this.promotions.set(interactionPoint, name);
      entry.promotedStrategy = name;
      logger.warn(
        `[selector-health] "${interactionPoint}" resolved via fallback "${name}" ${count}x in a row; ` +
          `preferred "${preferred}" appears to have drifted — promoting the fallback to the front of the cascade`,
        { interactionPoint, matchedStrategy: name, preferredStrategy: preferred, streak: count }
      );
    }
  }

  private _recordFailure(interactionPoint: string, cascade: SelectorStrategy[]): void {
    const entry = this._healthFor(interactionPoint, cascade);
    entry.failures += 1;
    entry.lastFailureAt = new Date().toISOString();
    logger.warn(
      `[selector-health] "${interactionPoint}" resolution failed — every cascade strategy missed`,
      { interactionPoint, strategiesTried: cascade.length }
    );
  }

  /**
   * Snapshot of per-interaction-point selector health for drift reporting.
   * Returns copies so callers can't mutate internal counters.
   */
  getSelectorHealthReport(): SelectorHealth[] {
    return Array.from(this.health.values()).map((entry) => ({
      ...entry,
      matchesByStrategy: { ...entry.matchesByStrategy },
    }));
  }

  async resolve(page: Page, interactionPoint: string): Promise<ElementHandle | null> {
    const cascade = this.registry[interactionPoint];
    if (!cascade || cascade.length === 0) {
      throw new Error(`Unknown interaction point or empty cascade: ${interactionPoint}`);
    }

    for (const strategyObj of this._ordered(interactionPoint, cascade)) {
      try {
        const result = await page.$(strategyObj.selector);
        if (result) {
          this._recordMatch(interactionPoint, cascade, strategyObj);
          return result;
        }
      } catch {
        // Ignore and try next
      }
    }
    return null;
  }

  async resolveAll(page: Page, interactionPoint: string): Promise<ElementHandle[]> {
    const cascade = this.registry[interactionPoint];
    if (!cascade || cascade.length === 0) {
      throw new Error(`Unknown interaction point: ${interactionPoint}`);
    }

    for (const strategyObj of this._ordered(interactionPoint, cascade)) {
      try {
        const results = await page.$$(strategyObj.selector);
        if (results && results.length > 0) {
          this._recordMatch(interactionPoint, cascade, strategyObj);
          return results;
        }
      } catch {
        // Ignore and try next
      }
    }
    return [];
  }

  async resolveRequired(page: Page, interactionPoint: string): Promise<ElementHandle> {
    const cascade = this.registry[interactionPoint];
    const result = await this.resolve(page, interactionPoint);
    if (!result) {
      this._recordFailure(interactionPoint, cascade || []);
      throw new SelectorNotFoundError(interactionPoint, cascade || []);
    }
    return result;
  }

  async resolveWithWait(
    page: Page,
    interactionPoint: string,
    options?: { timeout?: number; params?: Record<string, string> }
  ): Promise<ElementHandle> {
    const cascade = this.registry[interactionPoint];
    if (!cascade || cascade.length === 0) {
      throw new Error(`Unknown interaction point: ${interactionPoint}`);
    }

    const overallTimeout = options?.timeout ?? 10000;
    const perStrategyTimeout = 2000;
    const startTime = Date.now();

    for (const strategyObj of this._ordered(interactionPoint, cascade)) {
      if (Date.now() - startTime >= overallTimeout) {
        break; // Hard cap
      }
      try {
        // Limit the wait to perStrategyTimeout, or the remaining overall timeout
        const waitTime = Math.min(perStrategyTimeout, overallTimeout - (Date.now() - startTime));
        if (waitTime <= 0) break;

        let populatedSelector = strategyObj.selector;
        if (options?.params) {
          for (const [key, value] of Object.entries(options.params)) {
            populatedSelector = populatedSelector.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
          }
        }

        const result = await page.waitForSelector(populatedSelector, { timeout: waitTime });
        if (result) {
          this._recordMatch(interactionPoint, cascade, strategyObj);
          return result;
        }
      } catch {
        // Timeout typically throws. Catch and proceed to next strategy
      }
    }

    this._recordFailure(interactionPoint, cascade);
    throw new SelectorNotFoundError(interactionPoint, cascade);
  }

  /**
   * Like resolveWithWait, but returns the first cascade match that is actually
   * rendered (has a non-zero bounding box). LinkedIn's React login ships a
   * hidden duplicate form whose inputs/buttons match the same selectors but
   * have no clickable point, so plain resolveWithWait returns the first DOM
   * match (often the hidden one) and .click()/.type() target a dead element.
   * Polls until a laid-out element appears or the timeout elapses.
   */
  async resolveVisibleWithWait(
    page: Page,
    interactionPoint: string,
    options?: { timeout?: number }
  ): Promise<ElementHandle> {
    const cascade = this.registry[interactionPoint];
    if (!cascade || cascade.length === 0) {
      throw new Error(`Unknown interaction point: ${interactionPoint}`);
    }

    const overallTimeout = options?.timeout ?? 10000;
    const startTime = Date.now();

    while (Date.now() - startTime < overallTimeout) {
      for (const strategyObj of this._ordered(interactionPoint, cascade)) {
        let handles: ElementHandle[] = [];
        try {
          handles = await page.$$(strategyObj.selector);
        } catch {
          continue; // unsupported/invalid selector — try next strategy
        }
        for (const handle of handles) {
          const box = await handle.boundingBox().catch(() => null);
          if (box && box.width > 0 && box.height > 0) {
            this._recordMatch(interactionPoint, cascade, strategyObj);
            return handle;
          }
          await handle.dispose().catch(() => {});
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    this._recordFailure(interactionPoint, cascade);
    throw new SelectorNotFoundError(interactionPoint, cascade);
  }

  /**
   * Poll for the first cascade match to be PRESENT in the DOM (no visibility
   * requirement), re-scanning until found or the timeout elapses. Use for
   * "has this page loaded" checks where the target may render late or flicker
   * during React hydration (a visible-only check rejects it mid-churn). The
   * timeout floors at 30s, so a missing/zero option can't make it bail early.
   */
  async resolvePresentWithWait(
    page: Page,
    interactionPoint: string,
    options?: { timeout?: number }
  ): Promise<ElementHandle> {
    const cascade = this.registry[interactionPoint];
    if (!cascade || cascade.length === 0) {
      throw new Error(`Unknown interaction point: ${interactionPoint}`);
    }

    const requested = options?.timeout;
    const overallTimeout = typeof requested === 'number' && requested > 0 ? requested : 30000;
    const startTime = Date.now();

    while (Date.now() - startTime < overallTimeout) {
      for (const strategyObj of this._ordered(interactionPoint, cascade)) {
        try {
          const el = await page.$(strategyObj.selector);
          if (el) {
            this._recordMatch(interactionPoint, cascade, strategyObj);
            return el;
          }
        } catch {
          // unsupported/invalid selector — try next strategy
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    this._recordFailure(interactionPoint, cascade);
    throw new SelectorNotFoundError(interactionPoint, cascade);
  }

  async resolveWithParams(
    page: Page,
    interactionPoint: string,
    params: Record<string, string>
  ): Promise<ElementHandle | null> {
    const cascade = this.registry[interactionPoint];
    if (!cascade || cascade.length === 0) {
      throw new Error(`Unknown interaction point: ${interactionPoint}`);
    }

    for (const strategyObj of this._ordered(interactionPoint, cascade)) {
      let populatedSelector = strategyObj.selector;
      for (const [key, value] of Object.entries(params)) {
        populatedSelector = populatedSelector.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
      }

      try {
        const result = await page.$(populatedSelector);
        if (result) {
          this._recordMatch(interactionPoint, cascade, strategyObj);
          return result;
        }
      } catch {
        // Ignore
      }
    }
    return null;
  }
}
