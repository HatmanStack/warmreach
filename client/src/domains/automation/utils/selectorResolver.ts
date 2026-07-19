import type { Page, ElementHandle } from 'puppeteer';
import { SelectorRegistry, SelectorStrategy } from './selectorRegistry.js';

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

export class SelectorResolver {
  constructor(private registry: SelectorRegistry) {}

  async resolve(page: Page, interactionPoint: string): Promise<ElementHandle | null> {
    const cascade = this.registry[interactionPoint];
    if (!cascade || cascade.length === 0) {
      throw new Error(`Unknown interaction point or empty cascade: ${interactionPoint}`);
    }

    for (const strategyObj of cascade) {
      try {
        const result = await page.$(strategyObj.selector);
        if (result) {
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

    for (const strategyObj of cascade) {
      try {
        const results = await page.$$(strategyObj.selector);
        if (results && results.length > 0) {
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

    for (const strategyObj of cascade) {
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
          return result;
        }
      } catch {
        // Timeout typically throws. Catch and proceed to next strategy
      }
    }

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
      for (const strategyObj of cascade) {
        let handles: ElementHandle[] = [];
        try {
          handles = await page.$$(strategyObj.selector);
        } catch {
          continue; // unsupported/invalid selector — try next strategy
        }
        for (const handle of handles) {
          const box = await handle.boundingBox().catch(() => null);
          if (box && box.width > 0 && box.height > 0) {
            return handle;
          }
          await handle.dispose().catch(() => {});
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

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
      for (const strategyObj of cascade) {
        try {
          const el = await page.$(strategyObj.selector);
          if (el) {
            return el;
          }
        } catch {
          // unsupported/invalid selector — try next strategy
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

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

    for (const strategyObj of cascade) {
      let populatedSelector = strategyObj.selector;
      for (const [key, value] of Object.entries(params)) {
        populatedSelector = populatedSelector.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
      }

      try {
        const result = await page.$(populatedSelector);
        if (result) {
          return result;
        }
      } catch {
        // Ignore
      }
    }
    return null;
  }
}
