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
    constructor(private registry: SelectorRegistry) { }

    async resolve(
        page: Page,
        interactionPoint: string
    ): Promise<ElementHandle | null> {
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

    async resolveRequired(
        page: Page,
        interactionPoint: string
    ): Promise<ElementHandle> {
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
        options?: { timeout?: number, params?: Record<string, string> }
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
