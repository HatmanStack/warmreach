import { test, expect } from './fixtures/auth.fixture';

test.describe('Workflow Recovery', () => {
  test('should show heal and restore UI after interruption', async ({ authenticatedPage }) => {
    // 1. Start a long-running workflow (simulated)
    // We'll set a flag in localStorage that indicates an interrupted workflow
    await authenticatedPage.evaluate(() => {
      localStorage.setItem('workflow_checkpoint', JSON.stringify({
        type: 'batch_connection_request',
        payload: { count: 5 },
        timestamp: Date.now()
      }));
    });
    
    // 2. Reload page
    await authenticatedPage.reload();
    
    // 3. Verify heal & restore modal appears
    await expect(authenticatedPage.getByTestId('heal-restore-modal')).toBeVisible({ timeout: 15000 });
    
    // 4. Resume workflow
    await authenticatedPage.getByRole('button', { name: /resume/i }).click();
    
    // 5. Verify progress continues
    await expect(authenticatedPage.getByTestId('workflow-progress')).toBeVisible();
  });

  test('should allow dismissing the recovery prompt', async ({ authenticatedPage }) => {
    await authenticatedPage.evaluate(() => {
      localStorage.setItem(
        'workflow_checkpoint',
        JSON.stringify({
          type: 'batch_connection_request',
          payload: { count: 3 },
          timestamp: Date.now(),
        })
      );
    });

    await authenticatedPage.reload();

    await expect(authenticatedPage.getByTestId('heal-restore-modal')).toBeVisible({
      timeout: 15000,
    });

    // Dismiss instead of resuming
    await authenticatedPage.getByRole('button', { name: /dismiss|cancel|skip/i }).click();

    await expect(authenticatedPage.getByTestId('heal-restore-modal')).not.toBeVisible();
  });

  test('should not show recovery UI when no checkpoint exists', async ({ authenticatedPage }) => {
    // Ensure no checkpoint in localStorage
    await authenticatedPage.evaluate(() => {
      localStorage.removeItem('workflow_checkpoint');
    });

    await authenticatedPage.reload();

    // Modal should not appear
    await expect(authenticatedPage.getByTestId('heal-restore-modal')).not.toBeVisible({
      timeout: 3000,
    });
  });
});
