import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ES modules environment to match puppeteer's type: module
    environment: 'node',

    // Test file patterns
    include: ['src/**/*.test.js', 'src/**/*.test.ts'],

    // Setup file for common mocks
    setupFiles: ['./src/setupTests.js'],

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{js,ts}'],
      exclude: ['src/**/*.test.{js,ts}', 'src/setupTests.js'],
      // Initial floors — set to current-minus-2 so a regression trips CI.
      // Raise as test coverage grows. Stealth/Puppeteer code is intentionally
      // hard to cover, so the bar is modest. TODO: raise toward 70 once the
      // factory/mocks helpers in test-utils/ gain coverage.
      thresholds: {
        lines: 56,
        branches: 46,
        functions: 59,
        statements: 57,
      },
    },

    // Globals for cleaner test syntax
    globals: true,
  },
});
