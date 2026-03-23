import { logger } from '#utils/logger.js';
import config from '#shared-config/index.js';
import { linkedinResolver } from '../selectors/index.js';
import { LinkedInError } from '../utils/LinkedInError.js';
import { BaseLinkedInService } from './BaseLinkedInService.js';

/**
 * Handles messaging workflows: sending messages, navigating to messaging,
 * composing messages, and conversation scraping.
 * Extends BaseLinkedInService for shared infrastructure.
 */
export class InteractionMessagingService extends BaseLinkedInService {
  /**
   * @param {Object} options - Dependencies (same as BaseLinkedInService)
   * @param {Object} [options.messagingService] - Lower-level LinkedInMessagingService
   * @param {Object} [options.messageScraperService] - LinkedInMessageScraperService
   * @param {Object} [options.interactionNavigationService] - InteractionNavigationService
   */
  constructor(options = {}) {
    super(options);
    this.messagingDomainService = options.messagingService || null;
    this.messageScraperService = options.messageScraperService || null;
    this.interactionNavigationService = options.interactionNavigationService || null;
  }

  /**
   * Send a direct message to a LinkedIn connection
   * @param {string} recipientProfileId - Profile ID of message recipient
   * @param {string} messageContent - Message content to send
   * @param {string} userId - ID of authenticated user
   * @returns {Promise<Object>} Message result
   */
  async sendMessage(recipientProfileId, messageContent, userId) {
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
    this._enforceRateLimit();
    await this._applyControlPlaneRateLimits('sendMessage');
    await this.checkSuspiciousActivity();
    await this.getBrowserSession();

    const navigationSuccess = await this._navigateToProfile(recipientProfileId);
    if (!navigationSuccess) {
      throw new LinkedInError(
        `Failed to navigate to profile: ${recipientProfileId}`,
        'BROWSER_NAVIGATION_FAILED'
      );
    }

    await this.navigateToMessaging(recipientProfileId);
    const messageResult = await this.composeAndSendMessage(messageContent);

    this.sessionManager.lastActivity = new Date();

    this._scrapeAndStoreConversation(recipientProfileId).catch((err) => {
      logger.warn('Post-send conversation scrape failed (non-blocking)', {
        recipientProfileId,
        error: err.message,
      });
    });

    this._reportInteraction('sendMessage');

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
   * Navigate to profile, delegating to interactionNavigationService if available
   */
  async _navigateToProfile(profileId) {
    if (this.interactionNavigationService) {
      return this.interactionNavigationService.navigateToProfile(profileId);
    }
    // Fallback: inline navigation (shouldn't happen when properly wired)
    return false;
  }

  /**
   * Scrape the visible conversation thread after sending a message and update DynamoDB.
   * @param {string} profileId - Recipient profile ID
   */
  async _scrapeAndStoreConversation(profileId) {
    try {
      if (!this.messageScraperService) return;
      const messages = await this.messageScraperService.scrapeConversationThread(profileId);
      if (messages.length > 0) {
        await this.dynamoDBService.updateMessages(profileId, messages);
        logger.info(`Stored ${messages.length} messages for ${profileId} after send`);
      }
    } catch (error) {
      logger.warn(`Failed to scrape/store conversation for ${profileId}: ${error.message}`);
    }
  }

  /**
   * Navigate to LinkedIn messaging interface for a specific profile
   * @param {string} profileId - Profile ID to message
   * @returns {Promise<void>}
   */
  async navigateToMessaging(profileId) {
    logger.info(`Navigating to messaging interface for profile: ${profileId}`);

    try {
      const session = await this.getBrowserSession();
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
        await this.clickElementHumanly(page, messageButton);
        await this.waitForMessagingInterface();
      } else {
        const messagingUrl = `${config.linkedin.baseUrl}/messaging/thread/new?recipient=${encodeURIComponent(profileId)}`;
        logger.info(`Message button not found, navigating to new thread: ${messagingUrl}`);

        const navigationTimeout = this.configManager.get('navigationTimeout', 30000);
        await session.goto(messagingUrl, {
          waitUntil: 'networkidle',
          timeout: navigationTimeout,
        });

        await this.waitForMessagingInterface();
      }

      this.humanBehavior.recordAction('messaging_navigation', {
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
   * @returns {Promise<void>}
   */
  async waitForMessagingInterface() {
    try {
      const session = await this.getBrowserSession();
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
   * @param {string} messageContent - Message content to send
   * @returns {Promise<Object>} Message result with ID
   */
  async composeAndSendMessage(messageContent) {
    logger.info('Composing and sending LinkedIn message', {
      messageLength: messageContent.length,
    });

    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();

      await this.waitForMessagingInterface();

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

      await this.humanBehavior.simulateHumanMouseMovement(page, messageInput);
      await this.clearAndTypeText(page, messageInput, messageContent);

      const sendButton = await this._paced(1000, 2000, () =>
        linkedinResolver
          .resolveWithWait(page, 'messaging:send-button', { timeout: 3000 })
          .catch(() => null)
      );
      const sendSelector = 'messaging:send-button';

      if (!sendButton) {
        logger.info('Send button not found, trying Enter key');
        await page.keyboard.press('Enter');
      } else {
        await this.clickElementHumanly(page, sendButton);
      }

      await this.waitForMessageSent();

      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      this.humanBehavior.recordAction('message_sent', {
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
   * @returns {Promise<void>}
   */
  async waitForMessageSent() {
    try {
      const session = await this.getBrowserSession();

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
   * Complete LinkedIn messaging workflow
   * @param {string} recipientProfileId - Profile ID of message recipient
   * @param {string} messageContent - Message content to send
   * @param {Object} options - Additional options for messaging
   * @returns {Promise<Object>} Complete messaging result
   */
  async executeMessagingWorkflow(recipientProfileId, messageContent, options = {}) {
    const metrics = this.sessionManager.getSessionMetrics();
    try {
      const result = await this._executeMessagingWorkflowInternal(
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
  async _executeMessagingWorkflowInternal(recipientProfileId, messageContent, options = {}) {
    const context = {
      operation: 'executeMessagingWorkflow',
      recipientProfileId,
      messageLength: messageContent.length,
      options,
      startTime: Date.now(),
    };

    logger.info('Executing complete LinkedIn messaging workflow', context);
    this._enforceRateLimit();
    await this._applyControlPlaneRateLimits('executeMessagingWorkflow');

    await this.checkSuspiciousActivity();
    await this.getBrowserSession();

    logger.info('Step 1/4: Navigating to profile');
    const navigationSuccess = await this._navigateToProfile(recipientProfileId);
    if (!navigationSuccess) {
      throw new LinkedInError(
        `Failed to navigate to profile: ${recipientProfileId}`,
        'BROWSER_NAVIGATION_FAILED'
      );
    }

    logger.info('Step 2/4: Opening messaging interface');
    await this.navigateToMessaging(recipientProfileId);

    logger.info('Step 3/4: Composing and sending message');
    const messageResult = await this.composeAndSendMessage(messageContent);

    logger.info('Step 4/4: Verifying message delivery');
    const deliveryConfirmed = messageResult.deliveryStatus === 'sent';

    this.sessionManager.lastActivity = new Date();
    this.humanBehavior.recordAction('messaging_workflow_completed', {
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

    this._reportInteraction('executeMessagingWorkflow');

    logger.info('LinkedIn messaging workflow completed successfully', result);
    return result;
  }
}
