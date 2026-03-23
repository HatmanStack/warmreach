import { logger } from '#utils/logger.js';
import { linkedinResolver } from '../selectors/index.js';
import { LinkedInError } from '../utils/LinkedInError.js';
import { BaseLinkedInService } from './BaseLinkedInService.js';

/**
 * Handles follow/unfollow operations.
 * Extends BaseLinkedInService for shared infrastructure.
 */
export class InteractionFollowService extends BaseLinkedInService {
  /**
   * @param {Object} options - Dependencies (same as BaseLinkedInService)
   * @param {Object} [options.interactionNavigationService] - InteractionNavigationService
   * @param {Object} [options.interactionConnectionService] - InteractionConnectionService (for ensureEdge)
   */
  constructor(options = {}) {
    super(options);
    this.interactionNavigationService = options.interactionNavigationService || null;
    this.interactionConnectionService = options.interactionConnectionService || null;
  }

  /**
   * Follow a LinkedIn profile
   * @param {string} profileId - Profile ID to follow
   * @param {Object} options - Additional options (e.g., jwtToken)
   * @returns {Promise<Object>} Follow result
   */
  async followProfile(profileId, options = {}) {
    const metrics = this.sessionManager.getSessionMetrics();
    try {
      const result = await this._followProfileInternal(profileId, options);
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
  async _followProfileInternal(profileId, options = {}) {
    const context = {
      operation: 'followProfile',
      profileId,
      options,
    };

    logger.info('Executing LinkedIn follow profile workflow', context);

    try {
      this._enforceRateLimit();
      await this._applyControlPlaneRateLimits('followProfile');

      await this.checkSuspiciousActivity();
      await this.getBrowserSession();

      logger.info('Step 1/3: Navigating to profile');
      const navigationSuccess = await this._navigateToProfile(profileId);
      if (!navigationSuccess) {
        throw new LinkedInError(
          `Failed to navigate to profile: ${profileId}`,
          'BROWSER_NAVIGATION_FAILED'
        );
      }

      logger.info('Step 2/3: Checking follow status');
      const alreadyFollowing = await this.checkFollowStatus();
      if (alreadyFollowing) {
        logger.info(`Already following profile: ${profileId}`);
        await this._ensureEdge(profileId, 'followed', options?.jwtToken);
        return {
          status: 'already_following',
          profileId,
          followedAt: new Date().toISOString(),
        };
      }

      logger.info('Step 3/3: Clicking follow button');
      const followResult = await this.clickFollowButton(profileId);

      await this._ensureEdge(profileId, 'followed', options?.jwtToken);

      this.sessionManager.lastActivity = new Date();

      this.humanBehavior.recordAction('profile_followed', {
        profileId,
        timestamp: new Date().toISOString(),
      });

      this._reportInteraction('followProfile');

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

      this.humanBehavior.recordAction('follow_profile_failed', {
        profileId,
        error: error.message,
      });

      throw error;
    }
  }

  /**
   * Check if currently following a profile
   * @returns {Promise<boolean>} True if already following
   */
  async checkFollowStatus() {
    try {
      const session = await this.getBrowserSession();
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
   * @param {string} profileId - Profile ID being followed
   * @returns {Promise<Object>} Click result
   */
  async clickFollowButton(profileId) {
    try {
      const session = await this.getBrowserSession();
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
        const moreFound = await this._isProfileContainer('more');
        if (moreFound) {
          try {
            const element = await this._paced(500, 1000, () =>
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

      await this.clickElementHumanly(page, followButton);
      logger.info(`Clicked follow button for profile: ${profileId}`);

      const followConfirmed = await this._paced(1000, 2000, () => this.checkFollowStatus());

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

  /**
   * Navigate to profile, delegating to interactionNavigationService
   */
  async _navigateToProfile(profileId) {
    if (this.interactionNavigationService) {
      return this.interactionNavigationService.navigateToProfile(profileId);
    }
    return false;
  }

  /**
   * Ensure edge exists, delegating to interactionConnectionService if available
   */
  async _ensureEdge(profileId, status, jwtToken) {
    if (this.interactionConnectionService) {
      return this.interactionConnectionService.ensureEdge(profileId, status, jwtToken);
    }
    // Fallback: do it directly
    try {
      if (jwtToken) {
        this.dynamoDBService.setAuthToken(jwtToken);
      }
      await this.dynamoDBService.upsertEdgeStatus(profileId, status);
    } catch (error) {
      logger.warn(`Failed to create edge with status '${status}' via edge manager:`, error.message);
    }
  }

  /**
   * Check profile container for more button, delegating to connectionService
   */
  async _isProfileContainer(buttonName) {
    if (this.interactionConnectionService) {
      return this.interactionConnectionService.isProfileContainer(buttonName);
    }
    return false;
  }
}
