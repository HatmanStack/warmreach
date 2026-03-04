import { describe, it, expect } from 'vitest';
import { connectionSelectors } from './connectionSelectors.js';

describe('connectionSelectors', () => {
  it('exports a valid SelectorRegistry object', () => {
    expect(connectionSelectors).toBeDefined();
    expect(Object.keys(connectionSelectors).length).toBe(11);
  });

  it('has valid cascades for all interaction points', () => {
    for (const cascade of Object.values(connectionSelectors)) {
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
