import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Timeout and retry carry their reasoning, same convention as the coverage
    // thresholds below.
    //
    // At vitest's 5000ms default this suite passed or failed depending on
    // machine load, which makes a green run weak evidence. Measured on a
    // 12-core box by running 10 of the interactive component specs against 96
    // busy loops (8x oversubscription): 10 failures across 8 files, every one
    // "Test timed out in 5000ms", where the same 10 files pass unloaded. The
    // failing tests are ordinary synchronous render+assert bodies — the time
    // goes to module resolution and jsdom setup under contention, not to
    // anything the test awaits.
    //
    // 15s rather than 30s: three times the default is enough headroom for a
    // 2-core GitHub runner while still failing fast on a genuinely hung test.
    // This is headroom for a slow machine, NOT a licence to leave a slow test
    // in place — if a single test needs more than 15s, fix the test.
    testTimeout: 15000,
    // Retry under CI only, mirroring playwright.config.ts's
    // `retries: process.env.CI ? 2 : 0`. A local retry would hide flakiness
    // from the person best placed to fix it.
    retry: process.env.CI ? 1 : 0,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/setupTests.ts', 'src/shared/components/ui/**'],
      // Community-edition floors. Pro has more tests and runs higher floors;
      // do not copy pro numbers here without re-measuring community coverage.
      // Set at (current - ~2) to catch regressions without false-failing on drift.
      // lines 74 -> 73 and functions 68 -> 67: the P2 cleanup deletes fully-tested
      // dead code that also syncs to community (useConnections,
      // workflowProgressService, the Heal-and-Restore stack), mechanically
      // lowering the average; buffered down since community coverage isn't
      // measured from the pro repo. Re-measure community coverage before raising.
      thresholds: {
        lines: 73,
        branches: 65,
        functions: 67,
        statements: 74,
      },
    },
  },
  resolve: {
    alias: {
      '@/components': path.resolve(__dirname, './src/shared/components'),
      '@/hooks': path.resolve(__dirname, './src/shared/hooks'),
      '@/services': path.resolve(__dirname, './src/shared/services'),
      '@/utils': path.resolve(__dirname, './src/shared/utils'),
      '@': path.resolve(__dirname, './src'),
    },
  },
});
