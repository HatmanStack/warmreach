import { logger } from '#utils/logger.js';
import config from '#shared-config/index.js';
import { linkedinResolver } from '../selectors/index.js';
import { LinkedInError } from '../utils/LinkedInError.js';
import { BaseLinkedInService } from './BaseLinkedInService.js';

/**
 * Handles profile navigation and verification.
 * Extends BaseLinkedInService for shared infrastructure.
 */
export class InteractionNavigationService extends BaseLinkedInService {
  /**
   * @param {Object} options - Dependencies (same as BaseLinkedInService)
   * @param {Object} [options.linkedInNavigationService] - Lower-level navigation service
   */
  constructor(options = {}) {
    super(options);
    this.linkedInNavigationService = options.linkedInNavigationService || null;
  }

  /**
   * Navigate to a LinkedIn profile page
   * @param {string} profileId - LinkedIn profile ID or vanity URL
   * @returns {Promise<boolean>} True if navigation successful
   */
  async navigateToProfile(profileId) {
    logger.info(`Navigating to LinkedIn profile: ${profileId}`);

    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();

      // Construct profile URL - handle both profile IDs and full URLs
      let profileUrl;
      if (profileId.startsWith('http')) {
        profileUrl = profileId;
      } else if (profileId.includes('/in/')) {
        profileUrl = `${config.linkedin.baseUrl}${profileId}`;
      } else {
        profileUrl = `${config.linkedin.baseUrl}/in/${profileId}/`;
      }

      logger.info(`Navigating to LinkedIn profile: ${profileUrl}`);

      const navigationTimeout = this.configManager.get('navigationTimeout', 30000);
      await session.goto(profileUrl, {
        waitUntil: 'domcontentloaded',
        timeout: navigationTimeout,
      });

      await this.waitForLinkedInLoad();
      try {
        await this.waitForPageStability?.();
      } catch (error) {
        logger.debug('Page stability check failed, continuing anyway', { error: error.message });
      }

      const isProfilePage = await this.verifyProfilePage(page);
      if (!isProfilePage) {
        throw new LinkedInError(
          'Navigation did not result in a valid LinkedIn profile page',
          'BROWSER_NAVIGATION_FAILED'
        );
      }

      logger.info(`Successfully navigated to profile: ${profileId}`);
      return true;
    } catch (error) {
      logger.error(`Failed to navigate to profile ${profileId}:`, error);
      await this.sessionManager.recordError(error);
      return false;
    }
  }

  /**
   * Verify that we're on a valid LinkedIn profile page
   * @param {Object} page - Puppeteer page object
   * @returns {Promise<boolean>} True if on profile page
   */
  async verifyProfilePage(page) {
    try {
      const element = await linkedinResolver
        .resolveWithWait(page, 'nav:profile-indicator', { timeout: 2000 })
        .catch(() => null);
      if (element) {
        logger.debug('Profile page verified with resolver');
        return true;
      }

      const currentUrl = page.url();
      return currentUrl.includes('/in/') || currentUrl.includes('/profile/');
    } catch (error) {
      logger.debug('Profile page verification failed:', error.message);
      return false;
    }
  }
}
