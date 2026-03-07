import { test, expect } from './fixtures/auth.fixture';

test.describe('Messaging Workflow', () => {
  test('should select connection and compose message', async ({ authenticatedPage }) => {
    // 1. Ensure connections list is visible
    await expect(authenticatedPage.getByTestId('connections-list')).toBeVisible({ timeout: 15000 });
    
    // 2. Select a connection (must be 'ally' status to message)
    const allyCard = authenticatedPage.getByTestId('connection-card').filter({ hasText: 'Connected' }).first();
    await allyCard.click();
    
    // 3. Open message composer
    await authenticatedPage.getByRole('button', { name: /message/i }).click();
    await expect(authenticatedPage.getByTestId('message-modal')).toBeVisible();
    
    // 4. Generate message via AI
    await authenticatedPage.getByRole('button', { name: /generate/i }).click();
    await expect(authenticatedPage.getByTestId('workflow-progress')).toBeVisible();
    
    // 5. Wait for AI and verify content
    const composer = authenticatedPage.getByTestId('message-composer-textarea');
    await expect(composer).not.toBeEmpty({ timeout: 30000 });
    
    // 6. Test manual editing
    await composer.fill('Hello, this is a manual update.');
    
    // 7. Test validation (cannot send empty)
    await composer.clear();
    const sendBtn = authenticatedPage.getByRole('button', { name: /send/i });
    await expect(sendBtn).toBeDisabled();
  });

  test('should close message modal on cancel', async ({ authenticatedPage }) => {
    await expect(authenticatedPage.getByTestId('connections-list')).toBeVisible({ timeout: 15000 });

    const allyCard = authenticatedPage
      .getByTestId('connection-card')
      .filter({ hasText: 'Connected' })
      .first();
    await allyCard.click();

    await authenticatedPage.getByRole('button', { name: /message/i }).click();
    await expect(authenticatedPage.getByTestId('message-modal')).toBeVisible();

    // Cancel / close the modal
    await authenticatedPage.getByRole('button', { name: /close|cancel/i }).click();
    await expect(authenticatedPage.getByTestId('message-modal')).not.toBeVisible();
  });

  test('should allow manual message entry without AI generation', async ({ authenticatedPage }) => {
    await expect(authenticatedPage.getByTestId('connections-list')).toBeVisible({ timeout: 15000 });

    const allyCard = authenticatedPage
      .getByTestId('connection-card')
      .filter({ hasText: 'Connected' })
      .first();
    await allyCard.click();

    await authenticatedPage.getByRole('button', { name: /message/i }).click();
    await expect(authenticatedPage.getByTestId('message-modal')).toBeVisible();

    // Type message directly without generating
    const composer = authenticatedPage.getByTestId('message-composer-textarea');
    await composer.fill('Hi, I wanted to connect about a potential collaboration.');

    // Send button should be enabled with content
    const sendBtn = authenticatedPage.getByRole('button', { name: /send/i });
    await expect(sendBtn).toBeEnabled();
  });
});
