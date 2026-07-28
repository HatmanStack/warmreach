import { test, expect } from './fixtures/auth.fixture';

test.describe('Profile', () => {
  test('should display profile form after sign in', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/profile');

    // Profile form should be visible with input fields
    await expect(authenticatedPage.getByTestId('profile-name-input')).toBeVisible();
    await expect(authenticatedPage.getByTestId('profile-company-input')).toBeVisible();
    await expect(authenticatedPage.getByTestId('save-profile-button')).toBeVisible();
  });

  test('should update profile and see success feedback', { tag: '@needs-api' }, async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/profile');

    // Update the name field
    const nameInput = authenticatedPage.getByTestId('profile-name-input');
    await nameInput.clear();
    await nameInput.fill('E2E Test User');

    // Click save
    await authenticatedPage.getByTestId('save-profile-button').click();

    // Should see success feedback (toast notification)
    await expect(authenticatedPage.getByText(/saved|success/i)).toBeVisible({ timeout: 10000 });
  });
});
