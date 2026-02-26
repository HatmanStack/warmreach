/**
 * Creates a deterministic pseudo-random number generator (Mulberry32)
 * @param seed Numeric seed
 * @returns Function that returns a float in [0, 1)
 */
export function createSeededRandom(seed: number): () => number {
    return function () {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Converts a string to a 32-bit numeric seed (FNV-1a hash)
 * @param str Input string
 * @returns 32-bit integer seed
 */
export function seedFromString(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
