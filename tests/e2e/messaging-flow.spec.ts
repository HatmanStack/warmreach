import { test, expect } from './fixtures/auth.fixture';

test.describe('Messaging Flow', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await expect(authenticatedPage.getByTestId('connections-list')).toBeVisible({ timeout: 15000 });
  });

  test('should view message history for a connection', async ({ authenticatedPage }) => {
    // Click on the first connection
    await authenticatedPage.getByTestId('connection-card').first().click();
    
    // Check if message history is visible
    await expect(authenticatedPage.getByTestId('message-history')).toBeVisible();
    
    // Should see at least some messages (from mock data)
    const messages = authenticatedPage.getByTestId('message-item');
    await expect(messages.count()).resolves.toBeGreaterThan(0);
  });

  test('should trigger message generation', async ({ authenticatedPage }) => {
    // Click on the first connection
    await authenticatedPage.getByTestId('connection-card').first().click();
    
    // Click "Generate Message" button
    const generateBtn = authenticatedPage.getByRole('button', { name: /generate/i });
    await generateBtn.click();
    
    // Check for progress indicator
    await expect(authenticatedPage.getByTestId('workflow-progress')).toBeVisible();
    
    // Wait for completion (longer timeout for AI)
    await expect(authenticatedPage.getByTestId('generated-message-preview')).toBeVisible({ timeout: 30000 });
    
    // Should see generated content
    await expect(authenticatedPage.getByTestId('generated-message-content')).not.toBeEmpty();
  });

  test('should show tone analysis for generated message', async ({ authenticatedPage }) => {
    // Navigate to a generated message (assuming we are already there from previous test or navigate again)
    await authenticatedPage.getByTestId('connection-card').first().click();
    await authenticatedPage.getByRole('button', { name: /generate/i }).click();
    
    await expect(authenticatedPage.getByTestId('tone-analysis-card')).toBeVisible({ timeout: 30000 });
    await expect(authenticatedPage.getByText('Professionalism')).toBeVisible();
    await expect(authenticatedPage.getByText('Warmth')).toBeVisible();
  });
});
