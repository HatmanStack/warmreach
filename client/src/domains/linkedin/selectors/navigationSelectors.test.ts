import { describe, it, expect } from 'vitest';
import { navigationSelectors } from './navigationSelectors.js';

describe('navigationSelectors', () => {
    it('exports a valid SelectorRegistry object', () => {
        expect(navigationSelectors).toBeDefined();
        expect(Object.keys(navigationSelectors).length).toBe(10);
    });

    it('has valid cascades for all interaction points', () => {
        for (const cascade of Object.values(navigationSelectors)) {
            expect(Array.isArray(cascade)).toBe(true);
            expect(cascade.length).toBeGreaterThanOrEqual(1);

            const uniqueSelectors = new Set(cascade.map(s => s.selector));
            expect(uniqueSelectors.size).toBe(cascade.length);

            for (const strat of cascade) {
                expect(typeof strat.strategy).toBe('string');
                expect(typeof strat.selector).toBe('string');
                expect(strat.selector.trim()).not.toBe('');
            }
        }
    });
});
