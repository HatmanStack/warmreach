import { describe, it, expect } from 'vitest';
import { searchSelectors } from './searchSelectors.js';

describe('searchSelectors', () => {
  it('exports a valid SelectorRegistry object', () => {
    expect(searchSelectors).toBeDefined();
    expect(Object.keys(searchSelectors).length).toBe(10);
  });

  it('has valid cascades for all interaction points', () => {
    for (const cascade of Object.values(searchSelectors)) {
      expect(Array.isArray(cascade)).toBe(true);
      expect(cascade.length).toBeGreaterThanOrEqual(1);

      const uniqueSelectors = new Set(cascade.map((s) => s.selector));
      expect(uniqueSelectors.size).toBe(cascade.length);

      for (const strat of cascade) {
        expect(typeof strat.strategy).toBe('string');
        expect(typeof strat.selector).toBe('string');
        expect(strat.selector.trim()).not.toBe('');
      }
    }
  });
});
