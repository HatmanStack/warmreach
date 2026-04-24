import { describe, it, expect } from 'vitest';
import { API_CONFIG } from './appConfig';

describe('API_CONFIG', () => {
  it('has a sane timeout between 5s and 60s by default', () => {
    expect(API_CONFIG.TIMEOUT).toBeGreaterThanOrEqual(5000);
    expect(API_CONFIG.TIMEOUT).toBeLessThanOrEqual(60000);
  });

  it('defaults TIMEOUT to 30000 ms when VITE_API_TIMEOUT_MS is not set', () => {
    // The default timeout must be the documented 30s value when no override is provided.
    // This will hold in the test environment where VITE_API_TIMEOUT_MS is unset.
    if (import.meta.env.VITE_API_TIMEOUT_MS === undefined) {
      expect(API_CONFIG.TIMEOUT).toBe(30000);
    }
  });
});
