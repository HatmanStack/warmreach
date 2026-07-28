import { test, expect } from './fixtures/auth.fixture';

// Tagged @needs-api: these assert on connection, message, or profile data
// served by the HTTP API. Nothing provisions that in CI — tests/e2e/helpers/
// ministack.ts exists to seed it and is imported by no spec. The CI job runs
// `--grep-invert=@needs-api`; drop the tag as each becomes self-sufficient.
test.describe('Connections Management', { tag: '@needs-api' }, () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await expect(authenticatedPage.getByTestId('connections-list')).toBeVisible({ timeout: 15000 });
  });

  test('should search for a specific connection', async ({ authenticatedPage }) => {
    const searchInput = authenticatedPage.getByPlaceholder('Search your connections...');
    await searchInput.fill('John');
    
    // Results should filter
    await expect(authenticatedPage.getByTestId('connections-list')).toContainText('John');
  });

  test('should change connection status', async ({ authenticatedPage }) => {
    // Find the first connection card
    const firstConnection = authenticatedPage.getByTestId('connection-card').first();
    await expect(firstConnection).toBeVisible();
    
    // Click more options or status button
    const statusBadge = firstConnection.getByTestId('connection-status-badge');
    await statusBadge.click();
    
    // Change status to 'Incoming' (or equivalent display text)
    await authenticatedPage.getByText('Incoming').click();
    
    // Verify update
    await expect(statusBadge).toContainText('Incoming');
  });

  test('should clear search results', async ({ authenticatedPage }) => {
    const searchInput = authenticatedPage.getByPlaceholder('Search your connections...');
    await searchInput.fill('NonexistentUser');
    
    await expect(authenticatedPage.getByText('No connections found')).toBeVisible();
    
    // Click clear button if it exists, or just clear the input
    await searchInput.clear();
    
    await expect(authenticatedPage.getByTestId('connection-card').first()).toBeVisible();
  });
});
