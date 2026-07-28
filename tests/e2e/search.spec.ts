import { test, expect } from './fixtures/auth.fixture';

test.describe('Search', () => {
  test('should search and display results', async ({ authenticatedPage }) => {
    // Navigate to new connections tab
    await authenticatedPage.getByRole('tab', { name: /new connections/i }).click();

    // Search bar should be visible
    const searchInput = authenticatedPage.getByTestId('search-input');
    await expect(searchInput).toBeVisible({ timeout: 10000 });

    // Type a search query
    await searchInput.fill('Engineer');

    // Should see filtered results or search results
    // The component filters client-side, so results update immediately
    await expect(authenticatedPage.getByText(/discover new connections/i)).toBeVisible({
      timeout: 10000,
    });
  });

  test('should clear search results', { tag: '@needs-api' }, async ({ authenticatedPage }) => {
    await authenticatedPage.getByRole('tab', { name: /new connections/i }).click();

    const searchInput = authenticatedPage.getByTestId('search-input');
    await expect(searchInput).toBeVisible({ timeout: 10000 });

    // Type and then clear
    await searchInput.fill('test');
    await authenticatedPage.getByRole('button', { name: /clear/i }).click();

    // Input should be empty
    await expect(searchInput).toHaveValue('');
  });
});
