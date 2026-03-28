import { test, expect } from './fixtures/auth.fixture';

test.describe('Opportunities Page Smoke', () => {
  test('should render the opportunities page', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/opportunities');

    // Opportunities page should display a heading or list container
    const opportunitiesContent = authenticatedPage.locator(
      '[data-testid="opportunities-page"], [data-testid="opportunities-list"], h1, h2'
    );
    await expect(opportunitiesContent.first()).toBeVisible({ timeout: 15000 });
  });

  test('should display pipeline stages or opportunity list', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/opportunities');

    // Look for pipeline or opportunity-related content
    const pipelineContent = authenticatedPage.locator(
      'text=/opportunit|pipeline|prospect|stage/i'
    );
    await expect(pipelineContent.first()).toBeVisible({ timeout: 15000 });
  });

  test('should stay on opportunities route', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/opportunities');

    await authenticatedPage.waitForTimeout(2000);
    expect(authenticatedPage.url()).toContain('/opportunities');
  });
});
