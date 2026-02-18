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
      thresholds: {
        lines: 37,
        branches: 71,
        functions: 54,
        statements: 37,
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
