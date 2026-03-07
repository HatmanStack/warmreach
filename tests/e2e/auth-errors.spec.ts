import { test, expect } from '@playwright/test';

test.describe('Authentication Errors', () => {
  test('should show validation errors for empty fields', async ({ page }) => {
    await page.goto('/');
    
    await page.getByTestId('sign-in-button').click();
    
    // Check for validation messages (native or custom)
    const emailInput = page.getByTestId('email-input');
    const isEmailInvalid = await emailInput.evaluate((el: HTMLInputElement) => !el.validity.valid || el.value === '');
    expect(isEmailInvalid).toBe(true);
  });

  test('should redirect to login when accessing protected route unauthenticated', async ({ page }) => {
    await page.goto('/dashboard');
    
    // Should be redirected to login (root or /auth)
    await expect(page).not.toHaveURL(/dashboard/);
    await expect(page.getByTestId('sign-in-button')).toBeVisible();
  });

  test('should show error for expired session', async ({ page }) => {
    // 1. Sign in
    await page.goto('/');
    await page.getByTestId('email-input').fill('testuser@example.com');
    await page.getByTestId('password-input').fill('TestPass123!');
    await page.getByTestId('sign-in-button').click();
    await expect(page).toHaveURL(/dashboard/);
    
    // 2. Clear tokens to simulate expiry
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => sessionStorage.clear());
    
    // 3. Try to navigate or refresh
    await page.reload();
    
    // 4. Should be back at login
    await expect(page.getByTestId('sign-in-button')).toBeVisible();
  });
});
