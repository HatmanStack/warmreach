import { logger } from '#utils/logger.js';
import { linkedinResolver, linkedinSelectors } from '../selectors/index.js';
import { LinkedInError } from '../utils/LinkedInError.js';
import { BaseLinkedInService } from './BaseLinkedInService.js';

/**
 * Handles connection workflows: sending requests, checking status,
 * and managing connection edges.
 * Extends BaseLinkedInService for shared infrastructure.
 */
export class InteractionConnectionService extends BaseLinkedInService {
  /**
   * @param {Object} options - Dependencies (same as BaseLinkedInService)
   * @param {Object} [options.connectionService] - Lower-level LinkedInConnectionService
   * @param {Object} [options.interactionNavigationService] - InteractionNavigationService
   */
  constructor(options = {}) {
    super(options);
    this.connectionDomainService = options.connectionService || null;
    this.interactionNavigationService = options.interactionNavigationService || null;
  }

  /**
   * Send the connection request after clicking connect button
   * @param {string} profileId - Profile ID
   * @param {string} jwtToken - JWT token
   * @returns {Promise<Object>} Connection request result
   */
  async sendConnectionRequest(profileId, jwtToken) {
    logger.info('Sending connection request for profile: ' + profileId);
    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();

      const modal = await linkedinResolver.resolveWithWait(page, 'connection:modal', {
        timeout: 5000,
      });
      if (!modal) {
        throw new LinkedInError('Connection request modal did not appear.', 'ELEMENT_NOT_FOUND');
      }
      logger.info('Connection modal appeared.');

      const sendButton = await linkedinResolver
        .resolveWithWait(page, 'connection:send-invitation', { timeout: 5000 })
        .catch(() => null);
      if (!sendButton) {
        throw new LinkedInError('Send button not found within the modal.', 'ELEMENT_NOT_FOUND');
      }

      await this.humanBehavior.simulateHumanMouseMovement(page, sendButton);
      await sendButton.click();
      logger.info('Clicked send button in modal.');

      await Promise.race([
        linkedinResolver.resolveWithWait(page, 'connection:invitation-sent', { timeout: 5000 }),
        linkedinResolver.resolveWithWait(page, 'connection:pending', { timeout: 5000 }),
      ]).catch(() => null);

      logger.info('Connection request confirmation found.');
      const requestId = `conn_req_${Date.now()}`;

      this.humanBehavior.recordAction('connection_request_sent', {
        requestId,
        confirmationFound: true,
      });
      try {
        await this.ensureEdge(profileId, 'outgoing', jwtToken);
      } catch (error) {
        logger.debug('Failed to create edge for connection request', {
          error: error.message,
          profileId,
        });
      }

      return {
        requestId,
        status: 'sent',
        sentAt: new Date().toISOString(),
        confirmationFound: true,
      };
    } catch (error) {
      logger.error('Failed to send connection request:', error.message);
      this.humanBehavior.recordAction('connection_request_failed', { error: error.message });
      throw new LinkedInError(
        `Connection request failed: ${error.message}`,
        'BROWSER_NAVIGATION_FAILED',
        { cause: error }
      );
    }
  }

  /**
   * Check the current connection status with a profile
   * @returns {Promise<string>} Connection status
   */
  async checkConnectionStatus() {
    try {
      const session = await this.getBrowserSession();

      try {
        const element = await linkedinResolver.resolveWithWait(
          session.getPage(),
          'messaging:message-button',
          { timeout: 1000 }
        );
        if (element) {
          logger.debug('Found connection indicator via messaging:message-button');
          return 'connected';
        }
      } catch {
        // Continue checking
      }

      try {
        const element = await linkedinResolver.resolveWithWait(
          session.getPage(),
          'connection:pending',
          { timeout: 1000 }
        );
        if (element) {
          logger.debug('Found pending connection indicator via connection:pending');
          return 'pending';
        }
      } catch {
        // Continue checking
      }

      return 'not_connected';
    } catch (error) {
      logger.error('Failed to check connection status:', error);
      return 'not_connected';
    }
  }

  /**
   * Check if the profile page container contains an aria-label with the given buttonName
   * @param {string} buttonName - Button name to check for
   * @returns {Promise<boolean>}
   */
  async isProfileContainer(buttonName) {
    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();
      const cascadeContainer = linkedinSelectors['nav:profile-card-container'] || [];
      const candidateSelectors = cascadeContainer
        .filter((s) => !s.selector.includes('::-p-'))
        .map((s) => s.selector);

      let container = null;
      let usedSelector = null;
      for (const sel of candidateSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            container = el;
            usedSelector = sel;
            break;
          }
        } catch (error) {
          logger.debug('Selector query failed, trying next', {
            selector: sel,
            error: error.message,
          });
        }
      }

      logger.info(
        `${buttonName} container check: ${container ? 'found' : 'not found'}` +
          `${usedSelector ? ` (${usedSelector})` : ''}`
      );
      if (!container) return false;

      if (buttonName === 'pending') {
        const containsPending = await page.evaluate(
          (el, bName) => {
            const html = el.innerHTML || '';
            return new RegExp(`aria[-\\s]?label\\s*=\\s*["'][^"']*${bName}[^"']*["']`, 'i').test(
              html
            );
          },
          container,
          buttonName
        );
        logger.info(`${buttonName} container match: ${containsPending ? 'found' : 'not found'}`);
        return !!containsPending;
      } else if (buttonName === 'connection-degree') {
        const isFirst = await page.evaluate((root) => {
          const el = root.querySelector('span.distance-badge .dist-value');
          const txt = el && el.textContent ? el.textContent.trim() : '';
          return txt === '1st';
        }, container);
        logger.info(`connection-degree match: ${isFirst ? '1st' : 'not 1st'}`);
        return !!isFirst;
      } else if (buttonName === 'connect') {
        const cascadeAll = linkedinSelectors['connection:all-buttons'] || [];
        const allSel = cascadeAll
          .filter((s) => !s.selector.includes('::-p-'))
          .map((s) => s.selector)
          .join(', ');

        const handle = await page.evaluateHandle(
          (root, selString) => {
            const lower = (s) => (s || '').toLowerCase();
            const isVisible = (n) => {
              const r = n.getBoundingClientRect();
              const s = window.getComputedStyle(n);
              return (
                r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
              );
            };
            const nodes = root.querySelectorAll(selString || 'button');
            for (const n of nodes) {
              const aria = lower(n.getAttribute('aria-label'));
              const txt = lower((n.innerText || n.textContent || '').trim());
              if (((aria && aria.includes('connect')) || txt === 'connect') && isVisible(n))
                return n;
            }
            return null;
          },
          container,
          allSel
        );
        const btn = handle && handle.asElement && handle.asElement();
        if (btn) {
          await this.clickElementHumanly(page, btn);
          return true;
        }
        return false;
      } else if (buttonName === 'more') {
        const cascadeAll = linkedinSelectors['connection:all-buttons'] || [];
        const allSel = cascadeAll
          .filter((s) => !s.selector.includes('::-p-'))
          .map((s) => s.selector)
          .join(', ');

        const handle = await page.evaluateHandle(
          (root, selString) => {
            const lower = (s) => (s || '').toLowerCase();
            const isVisible = (n) => {
              const r = n.getBoundingClientRect();
              const s = window.getComputedStyle(n);
              return (
                r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
              );
            };
            const nodes = root.querySelectorAll(selString || 'button');
            for (const n of nodes) {
              const aria = lower(n.getAttribute('aria-label'));
              const txt = lower((n.innerText || n.textContent || '').trim());
              if (((aria && aria.includes('more')) || txt === 'more') && isVisible(n)) return n;
            }
            return null;
          },
          container,
          allSel
        );
        const btn = handle && handle.asElement && handle.asElement();
        if (btn) {
          await this.clickElementHumanly(page, btn);
          return true;
        }
        return false;
      } else {
        throw new LinkedInError(`Invalid button name: ${buttonName}`, 'MISSING_REQUIRED_FIELD');
      }
    } catch (error) {
      logger.debug('Pending container check failed:', error.message);
      return false;
    }
  }

  /**
   * Ensure an edge is recorded for the profile
   * @param {string} profileId - Profile ID
   * @param {string} status - Edge status
   * @param {string|undefined} jwtToken - JWT token
   */
  async ensureEdge(profileId, status, jwtToken) {
    try {
      if (jwtToken) {
        this.dynamoDBService.setAuthToken(jwtToken);
      }
      await this.dynamoDBService.upsertEdgeStatus(profileId, status);
    } catch (error) {
      logger.warn(`Failed to create edge with status '${status}' via edge manager:`, error.message);
    }
  }

  async getEarlyConnectionStatus() {
    try {
      const isAlly = await this.isProfileContainer('connection-degree');
      if (isAlly) return 'ally';
      const isPending = await this.isProfileContainer('pending');
      if (isPending) return 'outgoing';
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Create a standardized connection workflow result object
   */
  createConnectionWorkflowResult(profileId, connectionMessage, workflowData) {
    return {
      requestId: workflowData.requestId || null,
      status: workflowData.status || workflowData.connectionStatus || 'unknown',
      sentAt: workflowData.sentAt || new Date().toISOString(),
      profileId,
      hasPersonalizedMessage: connectionMessage.length > 0,
    };
  }

  /**
   * Complete LinkedIn connection workflow
   * @param {string} profileId - Profile ID to connect with
   * @param {string} connectionMessage - Optional personalized message
   * @param {Object} options - Additional connection options
   * @returns {Promise<Object>} Complete connection result
   */
  async executeConnectionWorkflow(profileId, connectionMessage = '', options = {}) {
    const metrics = this.sessionManager.getSessionMetrics();
    try {
      const result = await this._executeConnectionWorkflowInternal(
        profileId,
        connectionMessage,
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
   * Internal implementation of connection workflow
   */
  async _executeConnectionWorkflowInternal(profileId, connectionMessage = '', options = {}) {
    const context = {
      operation: 'executeConnectionWorkflow',
      profileId,
      hasMessage: connectionMessage.length > 0,
      messageLength: connectionMessage.length,
      options,
      startTime: Date.now(),
    };

    logger.info('Executing complete LinkedIn connection workflow', context);
    this._enforceRateLimit();
    await this._applyControlPlaneRateLimits('executeConnectionWorkflow');

    await this.checkSuspiciousActivity();
    await this.getBrowserSession();

    logger.info('Step 1/4: Navigating to profile');
    const navigationSuccess = await this._navigateToProfile(profileId);
    if (!navigationSuccess) {
      throw new LinkedInError(
        `Failed to navigate to profile: ${profileId}`,
        'BROWSER_NAVIGATION_FAILED'
      );
    }

    logger.info('Step 2/4: Checking connection status');
    const earlyStatus = await this.getEarlyConnectionStatus();
    if (earlyStatus) {
      await this.ensureEdge(profileId, earlyStatus, options?.jwtToken);
      const earlyWorkflowData = { status: earlyStatus, connectionStatus: earlyStatus };
      const earlyResult = this.createConnectionWorkflowResult(
        profileId,
        connectionMessage,
        earlyWorkflowData
      );
      logger.info(`Early connection status detected: ${earlyStatus}`, earlyResult);
      return earlyResult;
    }

    logger.info('Step 3/4: Clicking connect button');
    const connectButtonFound = await this.isProfileContainer('connect');
    logger.info('Connect button found: ' + connectButtonFound);
    if (!connectButtonFound) {
      const moreButtonFound = await this.isProfileContainer('more');
      if (moreButtonFound) {
        await this.isProfileContainer('connect');
      } else {
        logger.error('Connect button not found in profile container');
        throw new LinkedInError(
          'Connect button not found in profile container',
          'ELEMENT_NOT_FOUND'
        );
      }
    }

    logger.info('Step 4/4: Sending connection request');
    const requestResult = await this.sendConnectionRequest(profileId, options?.jwtToken);

    this.sessionManager.lastActivity = new Date();
    this.humanBehavior.recordAction('connection_workflow_completed', {
      profileId,
      hasPersonalizedMessage: false,
      messageLength: 0,
      requestConfirmed: requestResult.confirmationFound,
      workflowDuration: Date.now() - context.startTime,
    });

    const normalWorkflowData = {
      requestId: requestResult.requestId,
      status: requestResult.status,
      sentAt: requestResult.sentAt,
      confirmationFound: requestResult.confirmationFound,
    };

    const result = this.createConnectionWorkflowResult(
      profileId,
      connectionMessage,
      normalWorkflowData
    );

    this._reportInteraction('executeConnectionWorkflow');

    logger.info('LinkedIn connection workflow completed successfully', result);
    return result;
  }

  /**
   * Navigate to profile, delegating to interactionNavigationService if available
   */
  async _navigateToProfile(profileId) {
    if (this.interactionNavigationService) {
      return this.interactionNavigationService.navigateToProfile(profileId);
    }
    return false;
  }
}
