import { test, expect } from './fixtures/auth.fixture';

// Tagged @needs-api: these assert on connection, message, or profile data
// served by the HTTP API. Nothing provisions that in CI — tests/e2e/helpers/
// ministack.ts exists to seed it and is imported by no spec. The CI job runs
// `--grep-invert=@needs-api`; drop the tag as each becomes self-sufficient.
test.describe('Connections', { tag: '@needs-api' }, () => {
  test('should display connections list after sign in', async ({ authenticatedPage }) => {
    // Dashboard should show connections list
    await expect(authenticatedPage.getByTestId('connections-list')).toBeVisible({ timeout: 15000 });
    await expect(authenticatedPage.getByText('Your Connections')).toBeVisible();
  });

  test('should filter connections by status', async ({ authenticatedPage }) => {
    // Wait for connections to load
    await expect(authenticatedPage.getByTestId('connections-list')).toBeVisible({ timeout: 15000 });

    // Click the status filter dropdown
    await authenticatedPage.getByTestId('status-filter').click();

    // Select a status option (e.g., "Connected" for ally status)
    await authenticatedPage.getByText('Connected').click();

    // Filter should be applied — verify the dropdown shows the selected status
    await expect(authenticatedPage.getByTestId('status-filter')).toContainText('Connected');
  });
});
