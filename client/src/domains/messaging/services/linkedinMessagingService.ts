/**
 * LinkedIn Messaging Service - Handles message composition and sending.
 *
 * Extracted from LinkedInInteractionService for better separation of concerns.
 */

import { logger } from '#utils/logger.js';
import { linkedinResolver } from '../../linkedin/selectors/index.js';

interface SessionManagerLike {
  getInstance(opts: { reinitializeIfUnhealthy: boolean }): Promise<{
    getPage(): import('puppeteer').Page;
  }>;
}

interface NavigationServiceLike {
  navigateToProfile(profileId: string): Promise<void>;
}

interface DynamoDBServiceLike {
  upsertEdge(data: Record<string, unknown>): Promise<void>;
}

interface MessagingServiceOptions {
  sessionManager?: SessionManagerLike;
  navigationService?: NavigationServiceLike;
  dynamoDBService?: DynamoDBServiceLike;
}

interface MessageResult {
  messageId: string;
  recipientProfileId: string;
  userId: string;
  deliveryStatus: string;
  sentAt: string;
  messageLength: number;
  error?: string;
}

/**
 * Messaging service for LinkedIn direct messages.
 */
export class LinkedInMessagingService {
  private sessionManager: SessionManagerLike;
  private navigationService: NavigationServiceLike | undefined;
  private dynamoDBService: DynamoDBServiceLike | undefined;

  constructor(options: MessagingServiceOptions = {}) {
    if (!options.sessionManager) {
      throw new Error('LinkedInMessagingService requires sessionManager');
    }
    this.sessionManager = options.sessionManager;
    this.navigationService = options.navigationService;
    this.dynamoDBService = options.dynamoDBService;
  }

  /**
   * Send a message to a LinkedIn connection.
   */
  async sendMessage(
    recipientProfileId: string,
    messageContent: string,
    userId: string
  ): Promise<MessageResult> {
    logger.info(`Sending message to ${recipientProfileId}`);

    const result: MessageResult = {
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
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          logger.warn('Failed to record message edge', { error: errMsg });
        }
      }

      logger.info('Message sent successfully', { result });
      return result;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to send message', { error: err.message, recipientProfileId });
      result.deliveryStatus = 'failed';
      result.error = err.message;
      throw error;
    }
  }

  /**
   * Navigate to the messaging interface for current profile.
   */
  async navigateToMessaging(): Promise<void> {
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
   */
  async waitForMessagingInterface(): Promise<void> {
    const session = await this.sessionManager.getInstance({ reinitializeIfUnhealthy: false });
    const page = session.getPage();

    await linkedinResolver.resolveWithWait(page, 'messaging:message-input', { timeout: 10000 });
  }

  /**
   * Compose and send the message.
   */
  async composeAndSendMessage(messageContent: string): Promise<void> {
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
   */
  async waitForMessageSent(): Promise<boolean> {
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
