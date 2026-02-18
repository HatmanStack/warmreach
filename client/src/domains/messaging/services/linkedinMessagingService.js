/**
 * LinkedIn Messaging Service - Handles message composition and sending.
 *
 * Extracted from LinkedInInteractionService for better separation of concerns.
 */

import { logger } from '#utils/logger.js';

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

    const messageButtonSelectors = [
      '[data-view-name="message-button"]',
      'button[aria-label*="Message"]',
      'button:has-text("Message")',
      '[data-test-id="message-button"]',
    ];

    for (const selector of messageButtonSelectors) {
      try {
        const button = await page.waitForSelector(selector, { timeout: 3000 });
        if (button) {
          await button.click();
          await this.waitForMessagingInterface();
          return;
        }
      } catch {
        // try next selector
      }
    }

    throw new Error('Could not find message button');
  }

  /**
   * Wait for messaging interface to be ready.
   * @returns {Promise<void>}
   */
  async waitForMessagingInterface() {
    const session = await this.sessionManager.getInstance({ reinitializeIfUnhealthy: false });
    const page = session.getPage();

    const inputSelectors = [
      '[data-test-id="message-input"]',
      '[role="textbox"][aria-label*="message"]',
      '.msg-form__contenteditable',
      'div[contenteditable="true"]',
    ];

    for (const selector of inputSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        return;
      } catch {
        // try next
      }
    }

    throw new Error('Messaging interface did not load');
  }

  /**
   * Compose and send the message.
   * @param {string} messageContent - Message text
   * @returns {Promise<void>}
   */
  async composeAndSendMessage(messageContent) {
    const session = await this.sessionManager.getInstance({ reinitializeIfUnhealthy: false });
    const page = session.getPage();

    // Find message input
    const inputSelectors = [
      '[data-test-id="message-input"]',
      '[role="textbox"][aria-label*="message"]',
      '.msg-form__contenteditable',
      'div[contenteditable="true"]',
    ];

    let inputElement = null;
    for (const selector of inputSelectors) {
      try {
        inputElement = await page.waitForSelector(selector, { timeout: 2000 });
        if (inputElement) break;
      } catch {
        // try next
      }
    }

    if (!inputElement) {
      throw new Error('Could not find message input field');
    }

    // Type message
    await inputElement.click();
    await inputElement.type(messageContent, { delay: 30 });

    // Find and click send button
    const sendButtonSelectors = [
      '[data-test-id="send-button"]',
      'button[type="submit"]',
      'button:has-text("Send")',
      '[aria-label*="Send"]',
    ];

    for (const selector of sendButtonSelectors) {
      try {
        const sendButton = await page.waitForSelector(selector, { timeout: 2000 });
        if (sendButton) {
          await sendButton.click();
          return;
        }
      } catch {
        // try next
      }
    }

    throw new Error('Could not find send button');
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

      // Check if message appears in conversation
      const sentIndicators = [
        '.msg-s-message-list__event--last-event',
        '[data-test-id="message-sent"]',
      ];

      for (const selector of sentIndicators) {
        try {
          const indicator = await page.$(selector);
          if (indicator) return true;
        } catch {
          // continue
        }
      }

      return false; // No sent indicator found
    } catch {
      return false;
    }
  }
}

export default LinkedInMessagingService;
