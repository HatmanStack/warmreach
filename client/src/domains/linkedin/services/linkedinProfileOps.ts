// @ts-nocheck -- migrated from .js; full type annotations pending
/**
 * LinkedIn Profile Operations - Navigation, sessions, page verification
 *
 * Extracted from linkedinInteractionService.js as part of domain decomposition.
 * Each function receives the service instance as its first parameter.
 */

import { logger } from '#utils/logger.js';
import config from '#shared-config/index.js';
import { LinkedInError } from '../utils/LinkedInError.js';
import { linkedinResolver, linkedinSelectors } from '../selectors/index.js';
import { BrowserSessionManager } from '../../session/services/browserSessionManager.js';

/**
 * Navigate to a LinkedIn profile page
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {string} profileId - LinkedIn profile ID or vanity URL
 * @returns {Promise<boolean>} True if navigation successful
 */
export async function navigateToProfile(service, profileId) {
  logger.info(`Navigating to LinkedIn profile: ${profileId}`);

  try {
    const session = await service.getBrowserSession();
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
    const navigationTimeout = service.configManager.get('navigationTimeout', 30000);
    await session.goto(profileUrl, {
      waitUntil: 'domcontentloaded',
      timeout: navigationTimeout,
    });

    // Wait for profile page to load completely
    await service.waitForLinkedInLoad();
    // Extra stabilization wait using a lightweight heuristic
    try {
      await service.waitForPageStability();
    } catch (error) {
      logger.debug('Page stability check failed, continuing anyway', { error: error.message });
    }

    // Verify we're on a profile page
    const isProfilePage = await service.verifyProfilePage(page);
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
    await service.sessionManager.recordError(error);
    return false;
  }
}

/**
 * Verify that we're on a valid LinkedIn profile page
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {Object} page - Puppeteer page object
 * @returns {Promise<boolean>} True if on profile page
 */
export async function verifyProfilePage(service, page) {
  try {
    const element = await linkedinResolver
      .resolveWithWait(page, 'nav:profile-indicator', { timeout: 2000 })
      .catch(() => null);
    if (element) {
      logger.debug('Profile page verified with resolver');
      return true;
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
 * Wait for LinkedIn page to fully load
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @returns {Promise<void>}
 */
export async function waitForLinkedInLoad(service) {
  try {
    const session = await service.getBrowserSession();
    const page = session.getPage();

    const maxWaitMs = service.configManager.get('pageLoadMaxWait', 10000);
    const sampleIntervalMs = 250;
    const requiredStableSamples = 3;

    let lastMetrics = null;
    let stableSamples = 0;
    const startTs = Date.now();

    const navMain = (linkedinSelectors['nav:main-content'] || [])
      .filter((s) => !s.selector.includes('::-p-'))
      .map((s) => s.selector)
      .join(', ');
    const navPageLoaded = (linkedinSelectors['nav:page-loaded'] || [])
      .filter((s) => !s.selector.includes('::-p-'))
      .map((s) => s.selector)
      .join(', ');
    const navHomepage = (linkedinSelectors['nav:homepage'] || [])
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
        const controller = service.sessionManager.getBackoffController();
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

    // Fallback: ensure at least a key container exists before proceeding
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
 * Wait for page stability by sampling DOM metrics
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {number} maxWaitMs
 * @param {number} sampleIntervalMs
 * @returns {Promise<boolean>}
 */
export async function waitForPageStability(service, maxWaitMs = 8000, sampleIntervalMs = 300) {
  try {
    const session = await service.getBrowserSession();
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
 * Initialize or get existing browser session
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @returns {Promise<Object>} Browser session instance
 */
export async function initializeBrowserSession(service) {
  try {
    return await service.sessionManager.getInstance({ reinitializeIfUnhealthy: true });
  } catch (error) {
    logger.error('Failed to initialize browser session:', error);
    throw new LinkedInError(
      `Browser session initialization failed: ${error.message}`,
      'BROWSER_CRASH',
      { cause: error }
    );
  }
}

/**
 * Get the current browser session
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @returns {Promise<Object>} Browser session instance
 */
export async function getBrowserSession(service) {
  return await service.sessionManager.getInstance({ reinitializeIfUnhealthy: false });
}

/**
 * Close the browser session
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @returns {Promise<void>}
 */
export async function closeBrowserSession(service) {
  await service.sessionManager.cleanup();
}

/**
 * Check if session is active and healthy
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @returns {Promise<boolean>}
 */
export async function isSessionActive(service) {
  return await service.sessionManager.isSessionHealthy();
}

/**
 * Get comprehensive session status
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @returns {Promise<Object>}
 */
export async function getSessionStatus(service) {
  const sessionHealth = await service.sessionManager.getHealthStatus();
  const activityStats = {
    totalActions: 0,
    actionsLastHour: 0,
    actionsLastMinute: 0,
    averageActionInterval: 0,
    actionsByType: {},
  };
  const suspiciousActivity = { isSuspicious: false, patterns: [] };

  return {
    ...sessionHealth,
    humanBehavior: {
      ...activityStats,
      suspiciousActivity,
    },
  };
}

/**
 * Check for suspicious activity and apply appropriate measures
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @returns {Promise<Object>}
 */
export async function checkSuspiciousActivity(_service) {
  return { isSuspicious: false, patterns: [], recommendation: '' };
}

/**
 * Handle browser crash recovery
 * @param {import('./linkedinInteractionService.js').LinkedInInteractionService} service
 * @param {Error} error
 * @param {Object} context
 */
export async function handleBrowserRecovery(service, error, context) {
  try {
    logger.info('Attempting browser session recovery', { context, error: error.message });

    const recoveryPlan = (
      await import('../utils/linkedinErrorHandler.js')
    ).LinkedInErrorHandler.createRecoveryPlan(error, context);

    if (recoveryPlan.shouldRecover) {
      logger.info('Executing browser recovery plan', {
        actions: recoveryPlan.actions,
        delay: recoveryPlan.delay,
      });

      await BrowserSessionManager.cleanup();
      await BrowserSessionManager.getInstance({ reinitializeIfUnhealthy: true });

      logger.info('Browser session recovery completed');
    }
  } catch (recoveryError) {
    logger.error('Browser recovery failed', {
      originalError: error.message,
      recoveryError: recoveryError.message,
    });
  }
}
