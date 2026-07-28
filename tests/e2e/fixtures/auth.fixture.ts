import { test as base, type Page } from '@playwright/test';

/**
 * Fixture that provides an authenticated page.
 *
 * The sign-in form lives at /auth. '/' is the marketing landing page and has no
 * email-input, so a fixture that started there could never fill the form.
 */
export const test = base.extend<{ authenticatedPage: Page }>({
  authenticatedPage: async ({ page }, use) => {
    await page.goto('/auth');

    // Fill in credentials (MiniStack test user)
    await page.getByTestId('email-input').fill('testuser@example.com');
    await page.getByTestId('password-input').fill('TestPass123!');
    await page.getByTestId('sign-in-button').click();

    // Fail loudly. This used to .catch() into a console.warn, so a broken
    // sign-in handed every spec an unauthenticated page and the real cause was
    // only visible in the log while the assertions failed somewhere else.
    await page.waitForURL('**/dashboard', { timeout: 15000 });

    await use(page);
  },
});

export { expect } from '@playwright/test';
