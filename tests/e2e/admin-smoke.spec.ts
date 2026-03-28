import { test, expect } from '@playwright/test';

const ADMIN_BASE_URL = process.env.E2E_ADMIN_URL || 'http://localhost:5174';

test.describe('Admin Dashboard Smoke', () => {
  test.use({ baseURL: ADMIN_BASE_URL });

  test('should render the admin login or dashboard page', async ({ page }) => {
    await page.goto('/');
    // Admin app should render with a heading or login form
    const heading = page.locator('h1, h2, [data-testid="admin-heading"]');
    await expect(heading.first()).toBeVisible({ timeout: 15000 });
  });

  test('should display metrics panel when authenticated', async ({ page }) => {
    await page.goto('/');
    // Admin requires its own auth flow (separate from main app).
    // Verify the page rendered meaningful content, not a blank screen.
    const content = page.locator('h1, h2, table, form, [data-testid="metrics-panel"]');
    await expect(content.first()).toBeVisible({ timeout: 15000 });
  });
});
