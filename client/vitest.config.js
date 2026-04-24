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
      // Community-edition floors. Pro excludes (github, feed scraping, comment
      // concierge, content extractor, link following) remove several tested and
      // untested modules from community — do not copy pro thresholds here
      // without re-measuring. Set at the pre-Phase-5 baseline.
      thresholds: {
        lines: 50,
        branches: 45,
        functions: 50,
        statements: 50,
      },
    },

    // Globals for cleaner test syntax
    globals: true,
  },
});
