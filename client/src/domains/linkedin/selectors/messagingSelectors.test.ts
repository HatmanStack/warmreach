import { describe, it, expect } from 'vitest';
import { messagingSelectors } from './messagingSelectors.js';

describe('messagingSelectors', () => {
    it('exports a valid SelectorRegistry object', () => {
        expect(messagingSelectors).toBeDefined();
        expect(Object.keys(messagingSelectors).length).toBe(10);
    });

    it('has valid cascades for all interaction points', () => {
        for (const cascade of Object.values(messagingSelectors)) {
            expect(Array.isArray(cascade)).toBe(true);
            expect(cascade.length).toBeGreaterThanOrEqual(2);

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
