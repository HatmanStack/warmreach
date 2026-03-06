import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    frontend: {
      entry: ['src/pages/**/*.tsx'],
      project: ['src/**/*.{ts,tsx}'],
      ignore: ['src/shared/types/libsodium-wrappers-sumo.d.ts'],
    },
    client: {
      entry: ['electron-main.js', 'src/server.js', 'routes/**/*.js'],
      project: [
        'src/**/*.{js,ts}',
        'routes/**/*.js',
        '*.{js,mjs}',
        'config/**/*.js',
      ],
      ignore: [
        'knip.config.js',
        'linkedin-inspect.mjs',
        'src/credentials/settingsPreload.js',
      ],
    },
  },
  ignore: [
    '.sync/**',
    'tests/**',
    'mock-linkedin/**',
    'scripts/**',
    'backend/**',
    'docs/**',
  ],
};

export default config;
