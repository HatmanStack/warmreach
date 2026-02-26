import { describe, it, expect } from 'vitest';
import { createSeededRandom, seedFromString } from './seededRandom';

describe('seededRandom', () => {
    it('produces identical sequences for the same seed', () => {
        const rng1 = createSeededRandom(12345);
        const rng2 = createSeededRandom(12345);
        for (let i = 0; i < 100; i++) {
            expect(rng1()).toBe(rng2());
        }
    });

    it('produces different sequences for different seeds', () => {
        const rng1 = createSeededRandom(12345);
        const rng2 = createSeededRandom(54321);

        // They should diverge quickly
        let identical = true;
        for (let i = 0; i < 10; i++) {
            if (rng1() !== rng2()) {
                identical = false;
                break;
            }
        }
        expect(identical).toBe(false);
    });

    it('produces values >= 0 and < 1', () => {
        const rng = createSeededRandom(99999);
        for (let i = 0; i < 1000; i++) {
            const val = rng();
            expect(val).toBeGreaterThanOrEqual(0);
            expect(val).toBeLessThan(1);
        }
    });

    it('seedFromString always returns the same number for the same string', () => {
        expect(seedFromString('test-hash-123')).toBe(seedFromString('test-hash-123'));
        expect(seedFromString('hello')).toBe(seedFromString('hello'));
    });

    it('seedFromString returns different numbers for different strings', () => {
        expect(seedFromString('test')).not.toBe(seedFromString('other'));
        expect(seedFromString('hello')).not.toBe(seedFromString('world'));
    });
});
