import { describe, it, expect } from 'vitest';
import { linkedinSelectors, linkedinResolver } from './index.js';
import { SelectorResolver } from '../../automation/utils/selectorResolver.js';

describe('Combined Registry Index', () => {
    it('combines all individual registries without collisions', () => {
        const expectedKeysCount = 10 + 11 + 10 + 10 + 9 + 4; // 54
        expect(Object.keys(linkedinSelectors).length).toBe(expectedKeysCount);
        for (const val of Object.values(linkedinSelectors)) {
            expect(val).toBeDefined();
        }
    });

    it('exports a valid linkedinResolver instance', () => {
        expect(linkedinResolver).toBeInstanceOf(SelectorResolver);
    });
});
