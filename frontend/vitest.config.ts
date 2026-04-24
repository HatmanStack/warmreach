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
      // Floors set at (current coverage - 1 or 2) to catch regressions without
      // false-failing on small drift. Raise as coverage grows.
      thresholds: {
        lines: 76,
        branches: 67,
        functions: 71,
        statements: 76,
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
