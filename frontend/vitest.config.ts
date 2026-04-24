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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/setupTests.ts', 'src/shared/components/ui/**'],
      // Community-edition floors. Pro has more tests and runs higher floors;
      // do not copy pro numbers here without re-measuring community coverage.
      // Set at (current - ~2) to catch regressions without false-failing on drift.
      thresholds: {
        lines: 74,
        branches: 65,
        functions: 68,
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
