/**
 * LinkedIn Navigation Service - Handles page navigation and element interactions.
 *
 * Extracted from LinkedInInteractionService for better separation of concerns.
 * Provides navigation, page verification, and element interaction utilities.
 */

import { logger } from '#utils/logger.js';
import config from '#shared-config/index.js';

/**
 * Navigation service for LinkedIn page interactions.
 */
export class LinkedInNavigationService {
  /**
   * Create a new LinkedInNavigationService.
   * @param {Object} options
   * @param {Object} options.sessionManager - Browser session manager
   * @param {Object} options.configManager - Configuration manager
   */
  constructor(options = {}) {
    this.sessionManager = options.sessionManager;
    this.configManager = options.configManager;

    if (!this.sessionManager) {
      throw new Error('LinkedInNavigationService requires sessionManager');
    }
    if (!this.configManager) {
      throw new Error('LinkedInNavigationService requires configManager');
    }
  }

  /**
   * Get browser session (without auto-recovery to avoid side effects during navigation).
   * @returns {Promise<Object>} Browser session
   */
  async getBrowserSession() {
    return await this.sessionManager.getInstance({ reinitializeIfUnhealthy: false });
  }

  /**
   * Navigate to a LinkedIn profile page.
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

      // Navigate with timeout and error handling
      const navigationTimeout = this.configManager.get('navigationTimeout', 30000);
      await session.goto(profileUrl, {
        waitUntil: 'domcontentloaded',
        timeout: navigationTimeout,
      });

      // Wait for profile page to load completely
      await this.waitForLinkedInLoad();

      // Extra stabilization wait
      try {
        await this.waitForPageStability();
      } catch (error) {
        logger.debug('Page stability check failed, continuing anyway', { error: error.message });
      }

      // Verify we're on a profile page
      const isProfilePage = await this.verifyProfilePage(page);
      if (!isProfilePage) {
        throw new Error('Navigation did not result in a valid LinkedIn profile page');
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
   * Verify that we're on a valid LinkedIn profile page.
   * @param {Object} page - Puppeteer page object
   * @returns {Promise<boolean>} True if on profile page
   */
  async verifyProfilePage(page) {
    try {
      const profileIndicators = [
        '[data-view-name="profile-top-card-member-photo"]',
        '[data-view-name="profile-top-card-verified-badge"]',
        '[data-view-name="profile-main-level"]',
        '[data-view-name="profile-self-view"]',
        '[data-test-id="profile-top-card"]',
      ];

      for (const selector of profileIndicators) {
        try {
          const element = await page.waitForSelector(selector, { timeout: 2000 });
          if (element) {
            logger.debug(`Profile page verified with selector: ${selector}`);
            return true;
          }
        } catch {
          // Continue checking other selectors
        }
      }

      // Check URL pattern as fallback
      const currentUrl = page.url();
      return currentUrl.includes('/in/') || currentUrl.includes('/profile/');
    } catch (error) {
      logger.debug('Profile page verification failed:', error.message);
      return false;
    }
  }

  /**
   * Wait for LinkedIn SPA to finish loading.
   * Uses heuristic DOM stability detection.
   * @returns {Promise<void>}
   */
  async waitForLinkedInLoad() {
    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();

      const maxWaitMs = this.configManager.get('pageLoadMaxWait', 10000);
      const sampleIntervalMs = 250;
      const requiredStableSamples = 3;

      let lastMetrics = null;
      let stableSamples = 0;
      const startTs = Date.now();

      while (Date.now() - startTs < maxWaitMs) {
        const metrics = await page.evaluate(() => {
          const ready = document.readyState;
          const main = !!document.querySelector('main, [role="main"]');
          const scaffold =
            !!document.querySelector('[data-view-name*="navigation-"]') ||
            !!document.querySelector('header');
          const nav =
            !!document.querySelector('header') ||
            !!document.querySelector('[data-view-name="navigation-homepage"]');
          const anchors = document.querySelectorAll('a[href]')?.length || 0;
          const images = document.images?.length || 0;
          const height = document.body?.scrollHeight || 0;
          const url = location.href;
          const isCheckpoint = /checkpoint|authwall/i.test(url);
          return { ready, main, scaffold, nav, anchors, images, height, isCheckpoint };
        });

        const baseUiPresent =
          (metrics.main || metrics.scaffold || metrics.nav) && metrics.ready !== 'loading';

        if (
          lastMetrics &&
          baseUiPresent &&
          metrics.anchors === lastMetrics.anchors &&
          metrics.images === lastMetrics.images &&
          metrics.height === lastMetrics.height
        ) {
          stableSamples += 1;
          if (stableSamples >= requiredStableSamples) {
            return true;
          }
        } else {
          stableSamples = 0;
        }

        lastMetrics = metrics;
        await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));
      }

      // Fallback: ensure at least a key container exists
      await Promise.race([
        session.waitForSelector('main', { timeout: 2000 }),
        session.waitForSelector('.scaffold-layout', { timeout: 2000 }),
        session.waitForSelector('[data-test-id]', { timeout: 2000 }),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      logger.debug('LinkedIn page load heuristic finished without full stability; proceeding');
    }
  }

  /**
   * Wait for page DOM to stabilize.
   * @param {number} maxWaitMs - Maximum wait time
   * @param {number} sampleIntervalMs - Sampling interval
   * @returns {Promise<boolean>} True if page stabilized
   */
  async waitForPageStability(maxWaitMs = 8000, sampleIntervalMs = 300) {
    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();
      let last = null;
      let stable = 0;
      const start = Date.now();

      while (Date.now() - start < maxWaitMs) {
        const metrics = await page.evaluate(() => ({
          ready: document.readyState,
          links: document.querySelectorAll('a').length,
          imgs: document.images.length,
        }));

        if (
          last &&
          metrics.ready !== 'loading' &&
          metrics.links === last.links &&
          metrics.imgs === last.imgs
        ) {
          stable += 1;
          if (stable >= 3) return true;
        } else {
          stable = 0;
        }
        last = metrics;
        await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));
      }
    } catch (error) {
      logger.debug('Page stability monitoring failed', { error: error.message });
    }
    return false;
  }

  /**
   * Find the first element matching any selector in order.
   * @param {string[]} selectors - CSS selectors to try in order
   * @param {number} waitTimeout - Per-selector timeout in ms
   * @returns {Promise<{element: any, selector: string}>} Found element and selector or nulls
   */
  async findElementBySelectors(selectors, waitTimeout = 3000) {
    const session = await this.getBrowserSession();
    for (const selector of selectors) {
      try {
        const element = await session.waitForSelector(selector, { timeout: waitTimeout });
        if (element) {
          return { element, selector };
        }
      } catch {
        // try next selector
      }
    }
    return { element: null, selector: null };
  }

  /**
   * Wait until any of the provided selectors appears.
   * @param {string[]} selectors
   * @param {number} waitTimeout
   * @returns {Promise<{element: any, selector: string}>} Found element and selector or nulls
   */
  async waitForAnySelector(selectors, waitTimeout = 5000) {
    return await this.findElementBySelectors(selectors, waitTimeout);
  }

  /**
   * Perform a human-like click on an element.
   * @param {Object} page - Puppeteer page
   * @param {Object} element - Element to click
   */
  async clickElementHumanly(page, element) {
    await element.click();
  }

  /**
   * Clear existing content in a focused input and type text.
   * @param {Object} page - Puppeteer page
   * @param {Object} element - Input element
   * @param {string} text - Text to type
   */
  async clearAndTypeText(page, element, text) {
    await element.click();
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Delete');
    await element.type(text);
  }

  /**
   * Simple delay helper.
   * @param {number} ms - Milliseconds to delay
   */
  async delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default LinkedInNavigationService;
