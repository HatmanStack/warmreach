/**
 * LinkedIn Connection Service - Handles connection requests.
 *
 * Extracted from LinkedInInteractionService for better separation of concerns.
 */

import { logger } from '#utils/logger.js';
import { RandomHelpers } from '#utils/randomHelpers.js';

/**
 * Connection service for LinkedIn connection requests.
 */
export class LinkedInConnectionService {
  /**
   * Create a new LinkedInConnectionService.
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
  async sendConnectionRequest(profileId, connectionMessage = '', options = {}) {
    logger.info(`Sending connection request to ${profileId}`);

    const result = {
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
        } catch (error) {
          logger.warn('Failed to record connection edge', { error: error.message });
        }
      }

      logger.info('Connection request completed', { result });
      return result;
    } catch (error) {
      logger.error('Failed to send connection request', { error: error.message, profileId });
      result.status = 'failed';
      result.error = error.message;
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
  async checkConnectionStatus() {
    try {
      const session = await this.sessionManager.getInstance({ reinitializeIfUnhealthy: false });
      const page = session.getPage();

      // Check for "1st" degree indicator (using Puppeteer p-selectors)
      const firstDegreeSelectors = [
        '[data-test-id="distance-badge"] ::-p-text(1st)',
        '.distance-badge ::-p-text(1st)',
        '::-p-aria([name*="1st degree"])',
      ];

      for (const selector of firstDegreeSelectors) {
        try {
          const element = await page.$(selector);
          if (element) return 'ally';
        } catch {
          // continue
        }
      }

      // Check for pending request (outgoing)
      const pendingSelectors = ['button ::-p-text(Pending)', '::-p-aria([name*="Pending"])'];

      for (const selector of pendingSelectors) {
        try {
          const element = await page.$(selector);
          if (element) return 'outgoing';
        } catch {
          // continue
        }
      }

      // Check for incoming connection request
      const incomingSelectors = [
        'button ::-p-text(Accept)',
        '::-p-aria([name*="Accept"])',
        'button ::-p-text(Respond)',
        '::-p-aria([name*="invitation"])',
      ];

      for (const selector of incomingSelectors) {
        try {
          const element = await page.$(selector);
          if (element) return 'incoming';
        } catch {
          // continue
        }
      }

      return 'not_connected';
    } catch (error) {
      logger.debug('Error checking connection status', { error: error.message });
      return 'unknown';
    }
  }

  /**
   * Click the connect button and handle the modal.
   * @param {string} message - Optional personalized message
   * @returns {Promise<boolean>} True if connection request sent
   */
  async clickConnectButton(message = '') {
    const session = await this.sessionManager.getInstance({ reinitializeIfUnhealthy: false });
    const page = session.getPage();

    // Find connect button
    const connectButtonSelectors = [
      '[data-view-name="profile-actions-connect"]',
      'button[aria-label*="Connect"]',
      'button:has-text("Connect")',
      '[data-test-id="connect-button"]',
    ];

    let connectButton = null;
    for (const selector of connectButtonSelectors) {
      try {
        connectButton = await page.waitForSelector(selector, { timeout: 3000 });
        if (connectButton) break;
      } catch {
        // try next
      }
    }

    // Check "More" dropdown if direct connect not found
    if (!connectButton) {
      try {
        const moreButton = await page.waitForSelector('button[aria-label*="More"]', {
          timeout: 2000,
        });
        if (moreButton) {
          await moreButton.click();
          await new Promise((resolve) => setTimeout(resolve, 500));

          for (const selector of connectButtonSelectors) {
            try {
              connectButton = await page.waitForSelector(selector, { timeout: 2000 });
              if (connectButton) break;
            } catch {
              // continue
            }
          }
        }
      } catch {
        // no more button
      }
    }

    if (!connectButton) {
      throw new Error('Could not find connect button');
    }

    await connectButton.click();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Handle connection modal
    if (message) {
      try {
        const addNoteButton = await page.waitForSelector('button:has-text("Add a note")', {
          timeout: 3000,
        });
        if (addNoteButton) {
          await addNoteButton.click();
          await new Promise((resolve) => setTimeout(resolve, 500));

          const noteInput = await page.waitForSelector('textarea', { timeout: 2000 });
          if (noteInput) {
            await noteInput.type(message, { delay: 30 });
          }
        }
      } catch {
        logger.debug('Could not add personalized note');
      }
    }

    // Click send
    const sendSelectors = [
      'button[aria-label*="Send"]',
      'button:has-text("Send")',
      '[data-test-id="send-invitation"]',
    ];

    for (const selector of sendSelectors) {
      try {
        const sendButton = await page.waitForSelector(selector, { timeout: 3000 });
        if (sendButton) {
          await sendButton.click();
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return true;
        }
      } catch {
        // try next
      }
    }

    return false;
  }
}

export default LinkedInConnectionService;
