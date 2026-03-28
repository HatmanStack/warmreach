import { test, expect } from './fixtures/auth.fixture';

test.describe('Network Page Smoke', () => {
  test('should render the network page', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/network');

    // Network page should display a heading or graph container
    const networkContent = authenticatedPage.locator(
      '[data-testid="network-page"], [data-testid="network-graph"], h1, h2'
    );
    await expect(networkContent.first()).toBeVisible({ timeout: 15000 });
  });

  test('should display graph container or connection summary', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/network');

    // Look for graph visualization or connection count
    const graphArea = authenticatedPage.locator(
      'canvas, svg, [data-testid="network-graph"], [data-testid="connection-count"], text=/connections|network/i'
    );
    await expect(graphArea.first()).toBeVisible({ timeout: 15000 });
  });
});
