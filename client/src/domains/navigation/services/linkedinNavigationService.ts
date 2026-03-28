/**
 * LinkedIn Navigation Service - Handles page navigation and element interactions.
 *
 * Extracted from LinkedInInteractionService for better separation of concerns.
 * Provides navigation, page verification, and element interaction utilities.
 */

import { logger } from '#utils/logger.js';
import { config } from '#shared-config/index.js';
import { linkedinResolver, linkedinSelectors } from '../../linkedin/selectors/index.js';
import type { Page } from 'puppeteer';

interface SessionManagerLike {
  getInstance(opts: { reinitializeIfUnhealthy: boolean }): Promise<{
    getPage(): Page;
    goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<void>;
    waitForSelector(
      selector: string,
      opts: { timeout: number }
    ): Promise<import('puppeteer').ElementHandle | null>;
  }>;
  recordError(error: unknown): Promise<void>;
  getBackoffController(): { handleCheckpoint(url: string): Promise<void> } | null;
}

interface ConfigManagerLike {
  get(key: string, defaultValue: number): number;
}

interface NavigationOptions {
  sessionManager?: SessionManagerLike;
  configManager?: ConfigManagerLike;
}

/**
 * Navigation service for LinkedIn page interactions.
 */
export class LinkedInNavigationService {
  private sessionManager: SessionManagerLike;
  private configManager: ConfigManagerLike;

  constructor(options: NavigationOptions = {}) {
    if (!options.sessionManager) {
      throw new Error('LinkedInNavigationService requires sessionManager');
    }
    if (!options.configManager) {
      throw new Error('LinkedInNavigationService requires configManager');
    }
    this.sessionManager = options.sessionManager;
    this.configManager = options.configManager;
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
  async navigateToProfile(profileId: string): Promise<boolean> {
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
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.debug('Page stability check failed, continuing anyway', { error: errMsg });
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
  async verifyProfilePage(page: Page): Promise<boolean> {
    try {
      const element = await linkedinResolver.resolveWithWait(page, 'nav:profile-indicator', {
        timeout: 2000,
      });
      if (element) {
        logger.debug('Profile page verified with resolver');
        return true;
      }
    } catch {
      // Continue checking URL pattern as fallback
    }

    try {
      // Check URL pattern as fallback
      const currentUrl = page.url();
      return currentUrl.includes('/in/') || currentUrl.includes('/profile/');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.debug('Profile page verification failed:', errMsg);
      return false;
    }
  }

  /**
   * Wait for LinkedIn SPA to finish loading.
   * Uses heuristic DOM stability detection.
   * @returns {Promise<void>}
   */
  async waitForLinkedInLoad(): Promise<boolean | void> {
    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();

      const maxWaitMs = this.configManager.get('pageLoadMaxWait', 10000);
      const sampleIntervalMs = 250;
      const requiredStableSamples = 3;

      let lastMetrics: {
        ready: string;
        main: boolean;
        scaffold: boolean;
        nav: boolean;
        anchors: number;
        images: number;
        height: number;
        isCheckpoint: boolean;
        url: string;
      } | null = null;
      let stableSamples = 0;
      const startTs = Date.now();

      const navMain = (linkedinSelectors['nav:main-content'] ?? [])
        .filter((s) => !s.selector.includes('::-p-'))
        .map((s) => s.selector)
        .join(', ');
      const navPageLoaded = (linkedinSelectors['nav:page-loaded'] ?? [])
        .filter((s) => !s.selector.includes('::-p-'))
        .map((s) => s.selector)
        .join(', ');
      const navHomepage = (linkedinSelectors['nav:homepage'] ?? [])
        .filter((s) => !s.selector.includes('::-p-'))
        .map((s) => s.selector)
        .join(', ');

      while (Date.now() - startTs < maxWaitMs) {
        const metrics = await page.evaluate(
          (mainSel, loadedSel, homeSel) => {
            const ready = document.readyState;
            const main = mainSel
              ? mainSel.split(',').some((sel) => !!document.querySelector(sel.trim()))
              : false;
            const scaffold = loadedSel
              ? loadedSel.split(',').some((sel) => !!document.querySelector(sel.trim()))
              : false;
            const nav = homeSel
              ? homeSel.split(',').some((sel) => !!document.querySelector(sel.trim()))
              : false;
            const anchors = document.querySelectorAll('a[href]')?.length || 0;
            const images = document.images?.length || 0;
            const height = document.body?.scrollHeight || 0;
            const url = location.href;
            const isCheckpoint = /checkpoint|authwall|challenge|captcha/i.test(url);
            return { ready, main, scaffold, nav, anchors, images, height, isCheckpoint, url };
          },
          navMain,
          navPageLoaded,
          navHomepage
        );

        if (metrics.isCheckpoint) {
          logger.warn(`Checkpoint detected at ${metrics.url} — pausing automation`);
          const controller = this.sessionManager.getBackoffController();
          if (controller) {
            await controller.handleCheckpoint(metrics.url);
          }
        }

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
        linkedinResolver.resolveWithWait(page, 'nav:main-content', { timeout: 2000 }),
        linkedinResolver.resolveWithWait(page, 'nav:scaffold', { timeout: 2000 }),
        linkedinResolver.resolveWithWait(page, 'nav:any-test-id', { timeout: 2000 }),
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
      let last: { ready: DocumentReadyState; links: number; imgs: number } | null = null;
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
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.debug('Page stability monitoring failed', { error: errMsg });
    }
    return false;
  }

  /**
   * Find the first element matching any selector in order.
   * @param {string[]} selectors - CSS selectors to try in order
   * @param {number} waitTimeout - Per-selector timeout in ms
   * Returns the found element and matching selector, or nulls if none matched.
   */
  async findElementBySelectors(
    selectors: string[],
    waitTimeout = 3000
  ): Promise<{ element: import('puppeteer').ElementHandle | null; selector: string | null }> {
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
   * Returns the found element and matching selector, or nulls if none matched.
   */
  async waitForAnySelector(
    selectors: string[],
    waitTimeout = 5000
  ): Promise<{ element: import('puppeteer').ElementHandle | null; selector: string | null }> {
    return await this.findElementBySelectors(selectors, waitTimeout);
  }

  /**
   * Perform a human-like click on an element.
   * @param {Object} page - Puppeteer page
   * @param {Object} element - Element to click
   */
  async clickElementHumanly(
    _page: Page,
    element: import('puppeteer').ElementHandle
  ): Promise<void> {
    await element.click();
  }

  /**
   * Clear existing content in a focused input and type text.
   * @param {Object} page - Puppeteer page
   * @param {Object} element - Input element
   * @param {string} text - Text to type
   */
  async clearAndTypeText(
    page: Page,
    element: import('puppeteer').ElementHandle,
    text: string
  ): Promise<void> {
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
  async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
