import { test as base, type Page } from '@playwright/test';

/**
 * Fixture that provides an authenticated page via LocalStack Cognito.
 */
export const test = base.extend<{ authenticatedPage: Page }>({
  authenticatedPage: async ({ page }, use) => {
    // Navigate to app and sign in
    await page.goto('/');

    // Fill in credentials (LocalStack test user)
    await page.getByTestId('email-input').fill('testuser@example.com');
    await page.getByTestId('password-input').fill('TestPass123!');
    await page.getByTestId('sign-in-button').click();

    // Wait for navigation after login
    await page.waitForURL('**/dashboard', { timeout: 10000 }).catch(() => {
      console.warn('Auth fixture: dashboard redirect did not complete. Tests may fail if auth is required.');
    });

    await use(page);
  },
});

export { expect } from '@playwright/test';
