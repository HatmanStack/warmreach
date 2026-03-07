import { test, expect } from './fixtures/auth.fixture';

test.describe('Search Workflow', () => {
  test('should search, view profile and request connection', async ({ authenticatedPage }) => {
    // 1. Navigate to search
    await authenticatedPage.getByRole('tab', { name: /new connections/i }).click();
    
    // 2. Enter search query
    const searchInput = authenticatedPage.getByTestId('search-input');
    await searchInput.fill('Google Engineer');
    await authenticatedPage.keyboard.press('Enter');
    
    // 3. Verify results appear (from MSW/mock-linkedin)
    const resultCard = authenticatedPage.getByTestId('connection-card').first();
    await expect(resultCard).toBeVisible({ timeout: 15000 });
    
    // 4. Click on a result to view details
    await resultCard.click();
    await expect(authenticatedPage.getByTestId('profile-detail-view')).toBeVisible();
    
    // 5. Request connection
    const requestBtn = authenticatedPage.getByRole('button', { name: /request connection/i });
    await requestBtn.click();
    
    // 6. Verify status update
    await expect(authenticatedPage.getByText(/request sent/i)).toBeVisible();
  });

  test('should show empty state for no results', async ({ authenticatedPage }) => {
    await authenticatedPage.getByRole('tab', { name: /new connections/i }).click();

    const searchInput = authenticatedPage.getByTestId('search-input');
    await searchInput.fill('NonexistentUserQuery');
    await authenticatedPage.keyboard.press('Enter');

    await expect(authenticatedPage.getByText(/no results found/i)).toBeVisible();
  });

  test('should clear search and return to default view', async ({ authenticatedPage }) => {
    await authenticatedPage.getByRole('tab', { name: /new connections/i }).click();

    const searchInput = authenticatedPage.getByTestId('search-input');
    await searchInput.fill('Engineer');
    await authenticatedPage.keyboard.press('Enter');

    // Wait for results
    await expect(authenticatedPage.getByTestId('connection-card').first()).toBeVisible({
      timeout: 15000,
    });

    // Clear search
    await searchInput.clear();
    await authenticatedPage.keyboard.press('Enter');

    // Should return to default view (no search results section)
    await expect(authenticatedPage.getByTestId('connection-card').first()).not.toBeVisible({
      timeout: 5000,
    });
  });
});
