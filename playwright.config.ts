import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const ADMIN_BASE_URL = process.env.E2E_ADMIN_URL || 'http://localhost:5174';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'html' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Without this, `npm run test:e2e` silently required a hand-started Vite
  // server on 5173 and no doc said so, which is how an unwired suite drifts
  // until it no longer passes.
  webServer: [
    {
      command: 'npm run dev',
      url: process.env.E2E_BASE_URL || 'http://localhost:5173',
      // Locally, attach to a dev server you already have (fast loop). Under CI,
      // always start a clean one.
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    // admin-smoke.spec.ts targets a second origin, so the frontend server alone
    // does not make `npx playwright test` runnable from a clean shell. Guarded
    // on the directory because this config syncs verbatim and the community
    // edition has no admin/ — Playwright starts every webServer entry
    // regardless of which specs are selected, so an unguarded entry would break
    // the community E2E run even though admin-smoke.spec.ts is excluded there.
    ...(existsSync('admin')
      ? [
          {
            command: 'npm run dev -- --port 5174 --strictPort',
            cwd: 'admin',
            url: ADMIN_BASE_URL,
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
        ]
      : []),
  ],
});
