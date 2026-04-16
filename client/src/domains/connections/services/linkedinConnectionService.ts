/**
 * LinkedIn Connection Service - Handles connection requests.
 *
 * Extracted from LinkedInInteractionService for better separation of concerns.
 */

import { logger } from '#utils/logger.js';
import { RandomHelpers } from '#utils/randomHelpers.js';
import { linkedinResolver } from '../../linkedin/selectors/index.js';

/**
 * Connection service for LinkedIn connection requests.
 */
interface ConnectionServiceOptions {
  sessionManager: Record<string, any>;
  navigationService?: Record<string, any>;
  dynamoDBService?: Record<string, any>;
}

export class LinkedInConnectionService {
  sessionManager: Record<string, any>;
  navigationService: Record<string, any> | undefined;
  dynamoDBService: Record<string, any> | undefined;

  constructor(options: ConnectionServiceOptions = {} as ConnectionServiceOptions) {
    this.sessionManager = options.sessionManager;
    this.navigationService = options.navigationService;
    this.dynamoDBService = options.dynamoDBService;

    if (!this.sessionManager) {
      throw new Error('LinkedInConnectionService requires sessionManager');
    }
  }

  /**
   * Send a connection request to a profile.
   * @param {string} profileId - Target profile ID
   * @param {string} connectionMessage - Optional personalized message
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Connection result
   */
  async sendConnectionRequest(
    profileId: string,
    connectionMessage = '',
    options: Record<string, any> = {}
  ): Promise<Record<string, any>> {
    logger.info(`Sending connection request to ${profileId}`);

    const result: Record<string, any> = {
      requestId: `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      profileId,
      status: 'unknown',
      sentAt: new Date().toISOString(),
      hasPersonalizedMessage: !!connectionMessage,
    };

    try {
      // Navigate to profile if navigation service available
      if (this.navigationService) {
        await this.navigationService.navigateToProfile(profileId);
      }

      // Check current connection status
      const currentStatus = await this.checkConnectionStatus();
      if (currentStatus === 'ally') {
        logger.info('Already connected to this profile');
        result.status = 'ally';
        return result;
      }

      if (currentStatus === 'outgoing') {
        logger.info('Connection request already pending');
        result.status = 'outgoing';
        return result;
      }

      if (currentStatus === 'incoming') {
        logger.info('Incoming connection request exists from this profile');
        result.status = 'incoming';
        return result;
      }

      // Find and click connect button
      const connected = await this.clickConnectButton(connectionMessage);
      result.status = connected ? 'sent' : 'failed';
      result.confirmationFound = connected;

      // Record edge if DynamoDB service available
      if (this.dynamoDBService && options.userId) {
        try {
          await this.dynamoDBService.upsertEdge({
            userId: options.userId,
            targetProfileId: profileId,
            edgeType: 'connection_request',
            status: result.status,
          });
        } catch (error: unknown) {
          logger.warn('Failed to record connection edge', { error: (error as Error).message });
        }
      }

      logger.info('Connection request completed', { result });
      return result;
    } catch (error: unknown) {
      logger.error('Failed to send connection request', {
        error: (error as Error).message,
        profileId,
      });
      result.status = 'failed';
      result.error = (error as Error).message;
      return result;
    } finally {
      // Always add human-like delay between requests for rate-limiting
      await RandomHelpers.randomDelay(1000, 3000);
    }
  }

  /**
   * Check current connection status with the profile.
   * @returns {Promise<string>} Status: 'ally', 'outgoing', 'incoming', 'not_connected', 'unknown'
   */
  async checkConnectionStatus(): Promise<string> {
    try {
      const session = await this.sessionManager.getInstance({ reinitializeIfUnhealthy: false });
      const page = session.getPage();

      const isFirst = await linkedinResolver.resolve(page, 'connection:distance-1st');
      if (isFirst) return 'ally';

      const isPending = await linkedinResolver.resolve(page, 'connection:pending');
      if (isPending) return 'outgoing';

      const isIncoming = await linkedinResolver.resolve(page, 'connection:accept');
      if (isIncoming) return 'incoming';

      return 'not_connected';
    } catch (error: unknown) {
      logger.debug('Error checking connection status', { error: (error as Error).message });
      return 'unknown';
    }
  }

  /**
   * Click the connect button and handle the modal.
   * @param {string} message - Optional personalized message
   * @returns {Promise<boolean>} True if connection request sent
   */
  async clickConnectButton(message = ''): Promise<boolean> {
    const session = await this.sessionManager.getInstance({ reinitializeIfUnhealthy: false });
    const page = session.getPage();

    let connectButton = null;
    try {
      connectButton = await linkedinResolver.resolveWithWait(page, 'connection:connect-button', {
        timeout: 3000,
      });
    } catch {
      // Not found directly
    }

    if (!connectButton) {
      try {
        const moreButton = await linkedinResolver.resolveWithWait(page, 'connection:more-button', {
          timeout: 2000,
        });
        await moreButton.click();
        await new Promise((resolve) => setTimeout(resolve, 500));

        connectButton = await linkedinResolver.resolveWithWait(page, 'connection:connect-button', {
          timeout: 2000,
        });
      } catch {
        // no more button or connect button inside it
      }
    }

    if (!connectButton) {
      throw new Error('Could not find connect button');
    }

    await connectButton.click();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (message) {
      try {
        const addNoteButton = await linkedinResolver.resolveWithWait(page, 'connection:add-note', {
          timeout: 3000,
        });
        await addNoteButton.click();
        await new Promise((resolve) => setTimeout(resolve, 500));

        const noteInput = await linkedinResolver.resolveWithWait(page, 'connection:note-input', {
          timeout: 2000,
        });
        await noteInput.type(message, { delay: 30 });
      } catch {
        logger.debug('Could not add personalized note');
      }
    }

    try {
      const sendButton = await linkedinResolver.resolveWithWait(
        page,
        'connection:send-invitation',
        { timeout: 3000 }
      );
      await sendButton.click();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return true;
    } catch {
      return false;
    }
  }
}
