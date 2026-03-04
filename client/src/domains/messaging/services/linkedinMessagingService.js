/**
 * LinkedIn Messaging Service - Handles message composition and sending.
 *
 * Extracted from LinkedInInteractionService for better separation of concerns.
 */

import { logger } from '#utils/logger.js';
import { linkedinResolver } from '../../linkedin/selectors/index.js';

/**
 * Messaging service for LinkedIn direct messages.
 */
export class LinkedInMessagingService {
  /**
   * Create a new LinkedInMessagingService.
   * @param {Object} options
   * @param {Object} options.sessionManager - Browser session manager
   * @param {Object} options.navigationService - Navigation service
   * @param {Object} options.dynamoDBService - DynamoDB service for edge recording
   */
  constructor(options = {}) {
    this.sessionManager = options.sessionManager;
    this.navigationService = options.navigationService;
    this.dynamoDBService = options.dynamoDBService;

    if (!this.sessionManager) {
      throw new Error('LinkedInMessagingService requires sessionManager');
    }
  }

  /**
   * Send a message to a LinkedIn connection.
   * @param {string} recipientProfileId - Recipient's profile ID
   * @param {string} messageContent - Message text
   * @param {string} userId - Sender's user ID
   * @returns {Promise<Object>} Message result
   */
  async sendMessage(recipientProfileId, messageContent, userId) {
    logger.info(`Sending message to ${recipientProfileId}`);

    const result = {
      messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      recipientProfileId,
      userId,
      deliveryStatus: 'pending',
      sentAt: new Date().toISOString(),
      messageLength: messageContent?.length || 0,
    };

    try {
      // Navigate to profile if navigation service available
      if (this.navigationService) {
        await this.navigationService.navigateToProfile(recipientProfileId);
      }

      // Navigate to messaging interface
      await this.navigateToMessaging();

      // Compose and send message
      await this.composeAndSendMessage(messageContent);

      // Wait for confirmation
      const confirmed = await this.waitForMessageSent();

      result.deliveryStatus = confirmed ? 'sent' : 'pending';

      // Record edge if DynamoDB service available
      if (this.dynamoDBService && userId) {
        try {
          await this.dynamoDBService.upsertEdge({
            userId,
            targetProfileId: recipientProfileId,
            edgeType: 'message',
            metadata: { messageId: result.messageId },
          });
        } catch (error) {
          logger.warn('Failed to record message edge', { error: error.message });
        }
      }

      logger.info('Message sent successfully', { result });
      return result;
    } catch (error) {
      logger.error('Failed to send message', { error: error.message, recipientProfileId });
      result.deliveryStatus = 'failed';
      result.error = error.message;
      throw error;
    }
  }

  /**
   * Navigate to the messaging interface for current profile.
   * @returns {Promise<void>}
   */
  async navigateToMessaging() {
    const session = await this.sessionManager.getInstance({ reinitializeIfUnhealthy: false });
    const page = session.getPage();

    const button = await linkedinResolver.resolveWithWait(page, 'messaging:message-button', {
      timeout: 10000,
    });
    await button.click();
    await this.waitForMessagingInterface();
  }

  /**
   * Wait for messaging interface to be ready.
   * @returns {Promise<void>}
   */
  async waitForMessagingInterface() {
    const session = await this.sessionManager.getInstance({ reinitializeIfUnhealthy: false });
    const page = session.getPage();

    await linkedinResolver.resolveWithWait(page, 'messaging:message-input', { timeout: 10000 });
  }

  /**
   * Compose and send the message.
   * @param {string} messageContent - Message text
   * @returns {Promise<void>}
   */
  async composeAndSendMessage(messageContent) {
    const session = await this.sessionManager.getInstance({ reinitializeIfUnhealthy: false });
    const page = session.getPage();

    const inputElement = await linkedinResolver.resolveWithWait(page, 'messaging:message-input', {
      timeout: 10000,
    });

    // Type message
    await inputElement.click();
    await inputElement.type(messageContent, { delay: 30 });

    const sendButton = await linkedinResolver.resolveWithWait(page, 'messaging:send-button', {
      timeout: 10000,
    });
    await sendButton.click();
  }

  /**
   * Wait for message sent confirmation.
   * @returns {Promise<boolean>} True if sent indicator found, false otherwise
   */
  async waitForMessageSent() {
    try {
      const session = await this.sessionManager.getInstance({ reinitializeIfUnhealthy: false });
      const page = session.getPage();

      // Wait for sent indicator or input to clear
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const indicator = await linkedinResolver.resolve(page, 'messaging:sent-confirmation');
      return !!indicator;
    } catch {
      return false;
    }
  }
}

export default LinkedInMessagingService;
