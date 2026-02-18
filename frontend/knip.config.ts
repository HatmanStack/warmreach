import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: [
    'src/pages/**/*.tsx',
  ],
  project: [
    'src/**/*.{ts,tsx}',
  ],
  ignore: [
    // Test files
    'src/**/*.test.{ts,tsx}',
    'src/**/*.spec.{ts,tsx}',
    'src/setupTests.ts',
    // Generated types
    'src/**/*.d.ts',
    // Config files handled separately
    'vite.config.ts',
    'tailwind.config.ts',
    'vitest.config.ts',
  ],
};

export default config;
