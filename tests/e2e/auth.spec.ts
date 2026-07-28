import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  test('should sign in with valid credentials', async ({ page }) => {
    await page.goto('/auth');

    // Fill in credentials
    await page.getByTestId('email-input').fill('testuser@example.com');
    await page.getByTestId('password-input').fill('TestPass123!');
    await page.getByTestId('sign-in-button').click();

    // Should navigate to dashboard
    await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
  });

  test('should show error for invalid credentials', async ({ page }) => {
    await page.goto('/auth');

    await page.getByTestId('email-input').fill('wrong@example.com');
    await page.getByTestId('password-input').fill('WrongPass123!');
    await page.getByTestId('sign-in-button').click();

    // Should stay on auth page and show error
    await expect(page.getByText(/incorrect|invalid|failed/i)).toBeVisible({ timeout: 10000 });
  });

  // Tagged @needs-legal-gate, not @needs-api: the route and the assertion below
  // are both correct. What stops it is the legal-acceptance modal intercepting
  // the click on sign-out-button. Filed under its own reason so the count in
  // ci.yml stays true.
  test('should sign out and return to login', { tag: '@needs-legal-gate' }, async ({ page }) => {
    // First sign in
    await page.goto('/auth');
    await page.getByTestId('email-input').fill('testuser@example.com');
    await page.getByTestId('password-input').fill('TestPass123!');
    await page.getByTestId('sign-in-button').click();
    await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });

    // Click sign out
    await page.getByTestId('sign-out-button').click();

    // Dashboard's handleSignOut navigates to '/', the landing page — not to
    // /auth. Asserting on sign-in-button here asserted the sign-in FORM, which
    // only exists at /auth, so this could never pass. What sign-out actually
    // owes the user is: you are off the dashboard, and there is a way back in.
    await expect(page).not.toHaveURL(/dashboard/, { timeout: 10000 });
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible({ timeout: 10000 });
  });
});
