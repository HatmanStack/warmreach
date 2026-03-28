import { test, expect } from './fixtures/auth.fixture';

test.describe('Billing Page Smoke', () => {
  test('should render the billing page with tier information', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/billing');

    // Billing page should display tier or plan information
    const tierInfo = authenticatedPage.locator(
      '[data-testid="tier-info"], [data-testid="billing-page"], h1, h2'
    );
    await expect(tierInfo.first()).toBeVisible({ timeout: 15000 });
  });

  test('should display plan details or pricing', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/billing');

    // Look for pricing or plan-related text
    const planContent = authenticatedPage.locator(
      'text=/plan|tier|subscription|billing/i'
    );
    await expect(planContent.first()).toBeVisible({ timeout: 15000 });
  });

  test('should not navigate to Stripe checkout without user action', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/billing');

    // Page should stay on billing route (no automatic redirect to Stripe)
    await authenticatedPage.waitForTimeout(2000);
    expect(authenticatedPage.url()).toContain('/billing');
  });
});
