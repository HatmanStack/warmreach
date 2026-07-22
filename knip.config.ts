import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    frontend: {
      entry: ['src/pages/**/*.tsx'],
      project: ['src/**/*.{ts,tsx}'],
      ignore: ['src/shared/types/libsodium-wrappers-sumo.d.ts'],
      // tailwindcss/tw-animate-css are consumed via CSS @import in src/index.css.
      ignoreDependencies: ['tailwindcss', 'tw-animate-css'],
    },
    client: {
      entry: ['electron-main.js', 'routes/**/*.js'],
      project: ['src/**/*.{js,ts}', 'routes/**/*.js', '*.{js,mjs}', 'config/**/*.js'],
      ignore: ['knip.config.js', 'linkedin-inspect.mjs', 'src/credentials/settingsPreload.js'],
    },
    admin: {
      entry: ['src/main.tsx'],
      project: ['src/**/*.{ts,tsx}'],
      // tailwindcss is consumed via @tailwindcss/vite + CSS @import, not a JS import.
      // (jsdom/vite/@testing-library/jest-dom and setupTests.ts are already
      // recognized as used by knip's vitest detection, so they need no ignore.)
      ignoreDependencies: ['tailwindcss'],
    },
  },
  ignore: ['.sync/**', 'tests/**', 'mock-linkedin/**', 'scripts/**', 'backend/**'],
  // typedoc is used by the docs:api:ts npm script, not a JS import.
  ignoreDependencies: ['typedoc'],
};

export default config;
