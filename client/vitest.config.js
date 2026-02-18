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
      thresholds: {
        lines: 18,
        branches: 17,
        functions: 24,
        statements: 18,
      },
    },

    // Globals for cleaner test syntax
    globals: true,
  },
});
