import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ES modules environment to match puppeteer's type: module
    environment: 'node',

    // Test file patterns
    include: ['src/**/*.test.js', 'src/**/*.test.ts'],

    // Setup file for common mocks
    setupFiles: ['./src/setupTests.js'],

    // Same load-sensitivity guard as frontend/vitest.config.ts, which carries
    // the measurement. This suite runs in the node environment rather than
    // jsdom so it has less per-file setup cost and was not itself observed
    // failing, but it ran at the same 5000ms/0 defaults with the same exposure.
    // 15s is headroom for a slow 2-core runner, not room for a slow test.
    testTimeout: 15000,
    // CI only — a local retry hides flakiness from whoever can fix it.
    retry: process.env.CI ? 1 : 0,

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
