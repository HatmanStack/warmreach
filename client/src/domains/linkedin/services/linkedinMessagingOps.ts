// @ts-nocheck -- migrated from .js; full type annotations pending
/**
 * LinkedIn Messaging Operations - Message sending, composition, conversation scraping
 *
 * Extracted from linkedinInteractionService.js as part of domain decomposition.
 * Each function receives the service instance as its first parameter.
 */

import { logger } from '#utils/logger.js';
import config from '#shared-config/index.js';
import { LinkedInError } from '../utils/LinkedInError.js';
import { linkedinResolver } from '../selectors/index.js';

/**
 * Send a direct message to a LinkedIn connection
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} recipientProfileId
 * @param {string} messageContent
 * @param {string} userId
 * @returns {Promise<Object>}
 */
export async function sendMessage(service, recipientProfileId, messageContent, userId) {
  const context = {
    operation: 'sendMessage',
    recipientProfileId,
    messageLength: messageContent.length,
    userId,
  };

  logger.info(
    `Sending LinkedIn message to profile ${recipientProfileId} by user ${userId}`,
    context
  );
  service._enforceRateLimit();
  await service._applyControlPlaneRateLimits('sendMessage');

  await service.checkSuspiciousActivity();
  await service.getBrowserSession();

  const navigationSuccess = await service.navigateToProfile(recipientProfileId);
  if (!navigationSuccess) {
    throw new LinkedInError(
      `Failed to navigate to profile: ${recipientProfileId}`,
      'BROWSER_NAVIGATION_FAILED'
    );
  }

  await service.navigateToMessaging(recipientProfileId);
  const messageResult = await service.composeAndSendMessage(messageContent);

  service.sessionManager.lastActivity = new Date();

  // Scrape the visible conversation thread and update DynamoDB (fire-and-forget)
  service._scrapeAndStoreConversation(recipientProfileId).catch((err) => {
    logger.warn('Post-send conversation scrape failed (non-blocking)', {
      recipientProfileId,
      error: err.message,
    });
  });

  service._reportInteraction('sendMessage');

  logger.info(`Successfully sent LinkedIn message`, {
    recipientProfileId,
    messageId: messageResult.messageId,
    userId,
  });

  return {
    messageId: messageResult.messageId || `msg_${Date.now()}_${recipientProfileId}`,
    deliveryStatus: 'sent',
    sentAt: new Date().toISOString(),
    recipientProfileId,
    userId,
  };
}

/**
 * Scrape the visible conversation thread after sending a message and update DynamoDB.
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} profileId
 */
export async function _scrapeAndStoreConversation(service, profileId) {
  try {
    const messages = await service.messageScraperService.scrapeConversationThread(profileId);
    if (messages.length > 0) {
      await service.dynamoDBService.updateMessages(profileId, messages);
      logger.info(`Stored ${messages.length} messages for ${profileId} after send`);
    }
  } catch (error) {
    logger.warn(`Failed to scrape/store conversation for ${profileId}: ${error.message}`);
  }
}

/**
 * Navigate to LinkedIn messaging interface for a specific profile
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} profileId
 * @returns {Promise<void>}
 */
export async function navigateToMessaging(service, profileId) {
  logger.info(`Navigating to messaging interface for profile: ${profileId}`);

  try {
    const session = await service.getBrowserSession();
    const page = session.getPage();

    let messageButton = null;
    let foundSelector = 'messaging:message-button';
    try {
      messageButton = await linkedinResolver.resolveWithWait(page, 'messaging:message-button', {
        timeout: 3000,
      });
    } catch {
      messageButton = null;
    }

    if (messageButton) {
      await service.clickElementHumanly(page, messageButton);
      await service.waitForMessagingInterface();
    } else {
      const messagingUrl = `${config.linkedin.baseUrl}/messaging/thread/new?recipient=${encodeURIComponent(profileId)}`;
      logger.info(`Message button not found, navigating to new thread: ${messagingUrl}`);

      const navigationTimeout = service.configManager.get('navigationTimeout', 30000);
      await session.goto(messagingUrl, {
        waitUntil: 'networkidle',
        timeout: navigationTimeout,
      });

      await service.waitForMessagingInterface();
    }

    service.humanBehavior.recordAction('messaging_navigation', {
      profileId,
      method: messageButton ? 'button_click' : 'direct_url',
      selector: foundSelector,
      timestamp: new Date().toISOString(),
    });

    logger.info(`Successfully navigated to messaging interface for profile: ${profileId}`);
  } catch (error) {
    logger.error(`Failed to navigate to messaging interface for ${profileId}:`, error);

    throw new LinkedInError(
      `Messaging navigation failed: ${error.message}`,
      'BROWSER_NAVIGATION_FAILED',
      { cause: error }
    );
  }
}

/**
 * Wait for messaging interface to load
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @returns {Promise<void>}
 */
export async function waitForMessagingInterface(service) {
  try {
    const session = await service.getBrowserSession();
    const page = session.getPage();

    const messagingElement = await linkedinResolver
      .resolveWithWait(page, 'messaging:message-input', { timeout: 5000 })
      .catch(() => null);

    if (!messagingElement) {
      throw new LinkedInError('Messaging interface did not load properly', 'ELEMENT_NOT_FOUND');
    }
  } catch (error) {
    logger.error('Failed to wait for messaging interface:', error);
    throw error;
  }
}

/**
 * Compose and send a message in the LinkedIn messaging interface
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} messageContent
 * @returns {Promise<Object>}
 */
export async function composeAndSendMessage(service, messageContent) {
  logger.info('Composing and sending LinkedIn message', {
    messageLength: messageContent.length,
  });

  try {
    const session = await service.getBrowserSession();
    const page = session.getPage();

    await service.waitForMessagingInterface();

    const messageInput = await linkedinResolver
      .resolveWithWait(page, 'messaging:message-input', { timeout: 5000 })
      .catch(() => null);
    const foundSelector = 'messaging:message-input';

    if (!messageInput) {
      throw new LinkedInError(
        'Message input field not found in messaging interface',
        'ELEMENT_NOT_FOUND'
      );
    }

    await service.humanBehavior.simulateHumanMouseMovement(page, messageInput);
    await service.clearAndTypeText(page, messageInput, messageContent);

    const sendButton = await service._paced(1000, 2000, () =>
      linkedinResolver
        .resolveWithWait(page, 'messaging:send-button', { timeout: 3000 })
        .catch(() => null)
    );
    const sendSelector = 'messaging:send-button';

    if (!sendButton) {
      logger.info('Send button not found, trying Enter key');
      await page.keyboard.press('Enter');
    } else {
      await service.clickElementHumanly(page, sendButton);
    }

    await service.waitForMessageSent();

    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    service.humanBehavior.recordAction('message_sent', {
      messageLength: messageContent.length,
      inputSelector: foundSelector,
      sendSelector: sendSelector,
      messageId,
      timestamp: new Date().toISOString(),
    });

    logger.info('Successfully composed and sent LinkedIn message', { messageId });

    return {
      messageId,
      sentAt: new Date().toISOString(),
      messageLength: messageContent.length,
    };
  } catch (error) {
    logger.error('Failed to compose and send message:', error);

    throw new LinkedInError(
      `Message composition failed: ${error.message}`,
      'POST_CREATION_FAILED',
      { cause: error }
    );
  }
}

/**
 * Wait for message to be sent confirmation
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @returns {Promise<void>}
 */
export async function waitForMessageSent(service) {
  try {
    const session = await service.getBrowserSession();

    let sentConfirmed = false;
    try {
      const indicator = await linkedinResolver.resolveWithWait(
        session.getPage(),
        'messaging:sent-confirmation',
        { timeout: 5000 }
      );
      if (indicator) {
        logger.debug(`Message sent confirmation found`);
        sentConfirmed = true;
      }
    } catch {
      // Continue checking other indicators
    }

    if (!sentConfirmed) {
      logger.debug('Message sent confirmation not found, assuming sent based on timing');
    }
  } catch (error) {
    logger.debug('Message sent confirmation wait completed:', error.message);
  }
}

/**
 * Type text with human-like patterns
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} text
 * @param {Object} element
 * @returns {Promise<void>}
 */
export async function typeWithHumanPattern(service, text, element = null) {
  const session = await service.getBrowserSession();
  const page = session.getPage();
  if (element) {
    await element.type(text);
  } else {
    await page.keyboard.type(text);
  }
}

/**
 * Complete LinkedIn messaging workflow
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} recipientProfileId
 * @param {string} messageContent
 * @param {Object} options
 * @returns {Promise<Object>}
 */
export async function executeMessagingWorkflow(
  service,
  recipientProfileId,
  messageContent,
  options = {}
) {
  const metrics = service.sessionManager.getSessionMetrics();
  try {
    const result = await _executeMessagingWorkflowInternal(
      service,
      recipientProfileId,
      messageContent,
      options
    );
    metrics?.recordOperation(true);
    return result;
  } catch (error) {
    metrics?.recordOperation(false);
    throw error;
  }
}

/**
 * Internal implementation of messaging workflow
 */
async function _executeMessagingWorkflowInternal(
  service,
  recipientProfileId,
  messageContent,
  options = {}
) {
  const context = {
    operation: 'executeMessagingWorkflow',
    recipientProfileId,
    messageLength: messageContent.length,
    options,
    startTime: Date.now(),
  };

  logger.info('Executing complete LinkedIn messaging workflow', context);
  service._enforceRateLimit();
  await service._applyControlPlaneRateLimits('executeMessagingWorkflow');

  await service.checkSuspiciousActivity();
  await service.getBrowserSession();

  logger.info('Step 1/4: Navigating to profile');
  const navigationSuccess = await service.navigateToProfile(recipientProfileId);
  if (!navigationSuccess) {
    throw new LinkedInError(
      `Failed to navigate to profile: ${recipientProfileId}`,
      'BROWSER_NAVIGATION_FAILED'
    );
  }

  logger.info('Step 2/4: Opening messaging interface');
  await service.navigateToMessaging(recipientProfileId);

  logger.info('Step 3/4: Composing and sending message');
  const messageResult = await service.composeAndSendMessage(messageContent);

  logger.info('Step 4/4: Verifying message delivery');
  const deliveryConfirmed = messageResult.deliveryStatus === 'sent';

  service.sessionManager.lastActivity = new Date();
  service.humanBehavior.recordAction('messaging_workflow_completed', {
    recipientProfileId,
    messageLength: messageContent.length,
    deliveryConfirmed,
    workflowDuration: Date.now() - context.startTime,
  });

  const result = {
    workflowId: `msg_workflow_${Date.now()}_${recipientProfileId}`,
    messageId: messageResult.messageId || `msg_${Date.now()}_${recipientProfileId}`,
    deliveryStatus: deliveryConfirmed ? 'delivered' : 'sent',
    sentAt: new Date().toISOString(),
    recipientProfileId,
    messageLength: messageContent.length,
    workflowSteps: [
      { step: 'profile_navigation', status: 'completed' },
      { step: 'messaging_interface', status: 'completed' },
      { step: 'message_composition', status: 'completed' },
      { step: 'message_delivery', status: deliveryConfirmed ? 'confirmed' : 'pending' },
    ],
  };

  service._reportInteraction('executeMessagingWorkflow');

  logger.info('LinkedIn messaging workflow completed successfully', result);
  return result;
}
