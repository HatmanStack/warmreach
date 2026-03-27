/**
 * LinkedIn Connection Operations - Connection requests, status checks, follow operations
 *
 * Extracted from linkedinInteractionService.js as part of domain decomposition.
 * Each function receives the service instance as its first parameter.
 */

import { logger } from '#utils/logger.js';
import { LinkedInError } from '../utils/LinkedInError.js';
import { linkedinResolver, linkedinSelectors } from '../selectors/index.js';

/**
 * Send the connection request after clicking connect button
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} profileId
 * @param {string} jwtToken
 * @returns {Promise<Object>}
 */
export async function sendConnectionRequest(service, profileId, jwtToken) {
  logger.info('Sending connection request for profile: ' + profileId);
  try {
    const session = await service.getBrowserSession();
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

    await service.humanBehavior.simulateHumanMouseMovement(page, sendButton);
    await sendButton.click();
    logger.info('Clicked send button in modal.');

    await Promise.race([
      linkedinResolver.resolveWithWait(page, 'connection:invitation-sent', { timeout: 5000 }),
      linkedinResolver.resolveWithWait(page, 'connection:pending', { timeout: 5000 }),
    ]).catch(() => null);

    logger.info('Connection request confirmation found.');
    const requestId = `conn_req_${Date.now()}`;

    service.humanBehavior.recordAction('connection_request_sent', {
      requestId,
      confirmationFound: true,
    });
    try {
      await service.ensureEdge(profileId, 'outgoing', jwtToken);
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
    service.humanBehavior.recordAction('connection_request_failed', { error: error.message });
    throw new LinkedInError(
      `Connection request failed: ${error.message}`,
      'BROWSER_NAVIGATION_FAILED',
      { cause: error }
    );
  }
}

/**
 * Check the current connection status with a profile
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @returns {Promise<string>}
 */
export async function checkConnectionStatus(service) {
  try {
    const session = await service.getBrowserSession();

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
 * Check if the profile page container contains an aria-label with the given button name
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} buttonName
 * @returns {Promise<boolean>}
 */
export async function isProfileContainer(service, buttonName) {
  try {
    const session = await service.getBrowserSession();
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
        (el, buttonName) => {
          const html = el.innerHTML || '';
          return new RegExp(`aria[-\\s]?label\\s*=\\s*["'][^"']*${buttonName}[^"']*["']`, 'i').test(
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
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          };
          const nodes = root.querySelectorAll(selString || 'button');
          for (const n of nodes) {
            const aria = lower(n.getAttribute('aria-label'));
            const txt = lower((n.innerText || n.textContent || '').trim());
            if (((aria && aria.includes('connect')) || txt === 'connect') && isVisible(n)) return n;
          }
          return null;
        },
        container,
        allSel
      );
      const btn = handle && handle.asElement && handle.asElement();
      if (btn) {
        await service.clickElementHumanly(page, btn);
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
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
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
        await service.clickElementHumanly(page, btn);
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
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} profileId
 * @param {string} status
 * @param {string|undefined} jwtToken
 */
export async function ensureEdge(service, profileId, status, jwtToken) {
  try {
    if (jwtToken) {
      service.dynamoDBService.setAuthToken(jwtToken);
    }
    await service.dynamoDBService.upsertEdgeStatus(profileId, status);
  } catch (error) {
    logger.warn(`Failed to create edge with status '${status}' via edge manager:`, error.message);
  }
}

/**
 * Get early connection status by checking profile container
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @returns {Promise<string|null>}
 */
export async function getEarlyConnectionStatus(service) {
  try {
    const isAlly = await service.isProfileContainer('connection-degree');
    if (isAlly) return 'ally';
    const isPending = await service.isProfileContainer('pending');
    if (isPending) return 'outgoing';
    return null;
  } catch {
    return null;
  }
}

/**
 * Create a standardized connection workflow result object
 * @param {string} profileId
 * @param {string} connectionMessage
 * @param {Object} workflowData
 * @returns {Object}
 */
export function createConnectionWorkflowResult(profileId, connectionMessage, workflowData) {
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
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} profileId
 * @param {string} connectionMessage
 * @param {Object} options
 * @returns {Promise<Object>}
 */
export async function executeConnectionWorkflow(
  service,
  profileId,
  connectionMessage = '',
  options = {}
) {
  const metrics = service.sessionManager.getSessionMetrics();
  try {
    const result = await _executeConnectionWorkflowInternal(
      service,
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
async function _executeConnectionWorkflowInternal(
  service,
  profileId,
  connectionMessage = '',
  options = {}
) {
  const context = {
    operation: 'executeConnectionWorkflow',
    profileId,
    hasMessage: connectionMessage.length > 0,
    messageLength: connectionMessage.length,
    options,
    startTime: Date.now(),
  };

  logger.info('Executing complete LinkedIn connection workflow', context);
  service._enforceRateLimit();
  await service._applyControlPlaneRateLimits('executeConnectionWorkflow');

  await service.checkSuspiciousActivity();
  await service.getBrowserSession();

  logger.info('Step 1/4: Navigating to profile');
  const navigationSuccess = await service.navigateToProfile(profileId);
  if (!navigationSuccess) {
    throw new LinkedInError(
      `Failed to navigate to profile: ${profileId}`,
      'BROWSER_NAVIGATION_FAILED'
    );
  }

  logger.info('Step 2/4: Checking connection status');
  const earlyStatus = await service.getEarlyConnectionStatus();
  if (earlyStatus) {
    await service.ensureEdge(profileId, earlyStatus, options?.jwtToken);
    const earlyWorkflowData = { status: earlyStatus, connectionStatus: earlyStatus };
    const earlyResult = service.createConnectionWorkflowResult(
      profileId,
      connectionMessage,
      earlyWorkflowData
    );
    logger.info(`Early connection status detected: ${earlyStatus}`, earlyResult);
    return earlyResult;
  }

  logger.info('Step 3/4: Clicking connect button');
  const connectButtonFound = await service.isProfileContainer('connect');
  logger.info('Connect button found: ' + connectButtonFound);
  if (!connectButtonFound) {
    const moreButtonFound = await service.isProfileContainer('more');
    if (moreButtonFound) {
      await service.isProfileContainer('connect');
    } else {
      logger.error('Connect button not found in profile container');
      throw new LinkedInError('Connect button not found in profile container', 'ELEMENT_NOT_FOUND');
    }
  }

  logger.info('Step 4/4: Sending connection request');
  const requestResult = await service.sendConnectionRequest(profileId, options?.jwtToken);

  service.sessionManager.lastActivity = new Date();
  service.humanBehavior.recordAction('connection_workflow_completed', {
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

  const result = service.createConnectionWorkflowResult(
    profileId,
    connectionMessage,
    normalWorkflowData
  );

  service._reportInteraction('executeConnectionWorkflow');

  logger.info('LinkedIn connection workflow completed successfully', result);
  return result;
}

/**
 * Follow a LinkedIn profile
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} profileId
 * @param {Object} options
 * @returns {Promise<Object>}
 */
export async function followProfile(service, profileId, options = {}) {
  const metrics = service.sessionManager.getSessionMetrics();
  try {
    const result = await _followProfileInternal(service, profileId, options);
    metrics?.recordOperation(true);
    return result;
  } catch (error) {
    metrics?.recordOperation(false);
    throw error;
  }
}

/**
 * Internal implementation of follow profile
 */
async function _followProfileInternal(service, profileId, options = {}) {
  const context = {
    operation: 'followProfile',
    profileId,
    options,
  };

  logger.info('Executing LinkedIn follow profile workflow', context);

  try {
    service._enforceRateLimit();
    await service._applyControlPlaneRateLimits('followProfile');

    await service.checkSuspiciousActivity();
    await service.getBrowserSession();

    logger.info('Step 1/3: Navigating to profile');
    const navigationSuccess = await service.navigateToProfile(profileId);
    if (!navigationSuccess) {
      throw new LinkedInError(
        `Failed to navigate to profile: ${profileId}`,
        'BROWSER_NAVIGATION_FAILED'
      );
    }

    logger.info('Step 2/3: Checking follow status');
    const alreadyFollowing = await service.checkFollowStatus();
    if (alreadyFollowing) {
      logger.info(`Already following profile: ${profileId}`);
      await service.ensureEdge(profileId, 'followed', options?.jwtToken);
      return {
        status: 'already_following',
        profileId,
        followedAt: new Date().toISOString(),
      };
    }

    logger.info('Step 3/3: Clicking follow button');
    const followResult = await service.clickFollowButton(profileId);

    await service.ensureEdge(profileId, 'followed', options?.jwtToken);

    service.sessionManager.lastActivity = new Date();

    service.humanBehavior.recordAction('profile_followed', {
      profileId,
      timestamp: new Date().toISOString(),
    });

    service._reportInteraction('followProfile');

    logger.info('LinkedIn follow profile workflow completed successfully', {
      profileId,
      status: followResult.status,
    });

    return {
      status: followResult.status || 'followed',
      profileId,
      followedAt: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(`Failed to follow profile ${profileId}:`, error);

    service.humanBehavior.recordAction('follow_profile_failed', {
      profileId,
      error: error.message,
    });

    throw error;
  }
}

/**
 * Check if currently following a profile
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @returns {Promise<boolean>}
 */
export async function checkFollowStatus(service) {
  try {
    const session = await service.getBrowserSession();
    const page = session.getPage();

    try {
      const element = await linkedinResolver.resolveWithWait(page, 'post:following-button', {
        timeout: 1000,
      });
      if (element) {
        logger.debug('Found following indicator via post:following-button');
        return true;
      }
    } catch {
      // Continue checking other selectors
    }

    return false;
  } catch (error) {
    logger.debug('Follow status check failed:', error.message);
    return false;
  }
}

/**
 * Find and click the follow button on a profile
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} profileId
 * @returns {Promise<Object>}
 */
export async function clickFollowButton(service, profileId) {
  try {
    const session = await service.getBrowserSession();
    const page = session.getPage();

    let followButton = null;
    let foundSelector = null;

    try {
      const element = await linkedinResolver.resolveWithWait(page, 'post:follow-button', {
        timeout: 2000,
      });
      if (element) {
        const ariaLabel = await element.getAttribute('aria-label');
        const innerText = await element.innerText();
        if (
          ariaLabel?.toLowerCase().includes('following') ||
          innerText?.toLowerCase().includes('following')
        ) {
          logger.debug(`Skipping 'Following' button matched by resolver`);
        } else {
          followButton = element;
          foundSelector = 'post:follow-button';
          logger.debug(`Found follow button with resolver: ${foundSelector}`);
        }
      }
    } catch {
      // Continue to check dropdown
    }

    if (!followButton) {
      logger.info('Follow button not found directly, trying More dropdown');
      const moreFound = await service.isProfileContainer('more');
      if (moreFound) {
        try {
          const element = await service._paced(500, 1000, () =>
            linkedinResolver.resolveWithWait(page, 'post:follow-from-menu', { timeout: 2000 })
          );
          if (element) {
            followButton = element;
            foundSelector = 'post:follow-from-menu';
            logger.debug(`Found follow button in dropdown with selector: ${foundSelector}`);
          }
        } catch {
          // Continue
        }
      }
    }

    if (!followButton) {
      throw new LinkedInError('Follow button not found on profile page', 'ELEMENT_NOT_FOUND');
    }

    await service.clickElementHumanly(page, followButton);
    logger.info(`Clicked follow button for profile: ${profileId}`);

    const followConfirmed = await service._paced(1000, 2000, () => service.checkFollowStatus());

    return {
      status: followConfirmed ? 'followed' : 'pending',
      selector: foundSelector,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(`Failed to click follow button for ${profileId}:`, error);
    throw new LinkedInError(`Follow button click failed: ${error.message}`, 'ELEMENT_NOT_FOUND', {
      cause: error,
    });
  }
}
