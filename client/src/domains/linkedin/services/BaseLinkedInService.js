import { logger } from '#utils/logger.js';
import { LinkedInErrorHandler } from '../utils/linkedinErrorHandler.js';
import ConfigManager from '#shared-config/configManager.js';
import DynamoDBService from '../../storage/services/dynamoDBService.js';
import { BrowserSessionManager } from '../../session/services/browserSessionManager.js';
import { linkedinResolver, linkedinSelectors } from '../selectors/index.js';
import { LinkedInError } from '../utils/LinkedInError.js';
import { RateLimiter, RateLimitExceededError } from '../../automation/utils/rateLimiter.js';

const RandomHelpers = {
  /**
   * Wait for a random duration between minMs and maxMs
   */
  async randomDelay(minMs = 300, maxMs = 800) {
    const span = Math.max(0, maxMs - minMs);
    const delayMs = minMs + Math.floor(Math.random() * (span + 1));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  },
};

// RandomHelpers is used internally by BaseLinkedInService._paced()

/**
 * Base class for LinkedIn interaction sub-services.
 *
 * Holds shared state (page, browser) and receives collaborators
 * (rateLimiter, domHelpers, sessionManager) via constructor.
 * All domain sub-services extend this base class.
 */
export class BaseLinkedInService {
  /**
   * Create a new BaseLinkedInService.
   * @param {Object} options - Optional dependencies for testing
   * @param {Object} options.sessionManager - Session manager (defaults to BrowserSessionManager)
   * @param {Object} options.configManager - Config manager (defaults to ConfigManager)
   * @param {Object} options.dynamoDBService - DynamoDB service instance
   * @param {Object} options.humanBehavior - Human behavior simulator (defaults to no-op)
   * @param {Object} options.controlPlaneService - Control plane service (defaults to no-op)
   * @param {Object} options.rateLimiter - Shared RateLimiter instance (defaults to new RateLimiter)
   */
  constructor(options = {}) {
    // Inject core dependencies or use defaults
    this.sessionManager = options.sessionManager || BrowserSessionManager;
    this.configManager = options.configManager || ConfigManager;
    this.dynamoDBService = options.dynamoDBService || new DynamoDBService();
    this.controlPlaneService = options.controlPlaneService || null;

    // Provide safe no-op fallbacks for human behavior simulation
    this.humanBehavior = options.humanBehavior || {
      async checkAndApplyCooldown() {
        /* no-op */
      },
      async simulateHumanMouseMovement() {
        /* no-op */
      },
      recordAction() {
        /* no-op */
      },
    };

    // Get configuration values
    const errorConfig = this.configManager.getErrorHandlingConfig();
    this.maxRetries = errorConfig.retryAttempts;
    this.baseRetryDelay = errorConfig.retryBaseDelay;

    // Rate limiter — accept injected instance for shared limiting across sub-services
    this._rateLimiter = options.rateLimiter || new RateLimiter();
  }

  /**
   * Execute a callback after a random delay. The delay is integral to the
   * return path -- removing it breaks the function.
   */
  async _paced(minMs, maxMs, fn) {
    await RandomHelpers.randomDelay(minMs, maxMs);
    return await fn();
  }

  /**
   * Enforce hard-coded rate limits. Delegates to the extracted RateLimiter class.
   * Wraps RateLimitExceededError as LinkedInError for backward compatibility.
   */
  _enforceRateLimit() {
    try {
      this._rateLimiter.enforce();
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        throw new LinkedInError('Rate limit exceeded', 'LINKEDIN_RATE_LIMIT');
      }
      throw err;
    }
  }

  /**
   * Apply centralized rate limits from the control plane (if configured).
   * The control plane can only make limits stricter, never more lenient
   * than the hard-coded ceilings.
   * @param {string} operation - Operation type for telemetry
   */
  async _applyControlPlaneRateLimits(_operation) {
    if (!this.controlPlaneService?.isConfigured) return;
    try {
      const cpLimits = await this.controlPlaneService.syncRateLimits();
      if (cpLimits?.linkedin_interactions) {
        const cp = cpLimits.linkedin_interactions;
        // Merge CP limits into configManager -- CP can only tighten, not loosen
        if (cp.daily_limit != null) {
          const current = this.configManager.get('dailyInteractionLimit', 500);
          this.configManager.setOverride(
            'dailyInteractionLimit',
            Math.min(current, cp.daily_limit)
          );
        }
        if (cp.hourly_limit != null) {
          const current = this.configManager.get('hourlyInteractionLimit', 100);
          this.configManager.setOverride(
            'hourlyInteractionLimit',
            Math.min(current, cp.hourly_limit)
          );
        }
      }
    } catch (error) {
      logger.debug('Control plane rate limit sync skipped', { error: error.message });
    }
  }

  /**
   * Report a completed interaction to the control plane (fire-and-forget).
   * @param {string} operation - Operation type
   */
  _reportInteraction(operation) {
    if (!this.controlPlaneService?.isConfigured) return;
    try {
      this.controlPlaneService.reportInteraction(operation);
    } catch {
      // Never block on telemetry failures
    }
  }

  /**
   * Execute operation once with error categorization (no retry).
   * @param {Function} operation - The operation to execute
   * @param {Object} context - Context information for error handling
   * @returns {Promise<any>} Operation result
   */
  async executeOnce(operation, context = {}) {
    try {
      context.attemptCount = 1;
      return await operation();
    } catch (error) {
      const categorizedError = LinkedInErrorHandler.categorizeError(error, context);
      logger.error(`Operation ${context.operation || 'unknown'} failed without retry`, {
        context,
        error: error.message,
        errorCategory: categorizedError.category,
      });
      throw error;
    }
  }

  /**
   * Handle browser crash recovery
   * @param {Error} error - Browser error
   * @param {Object} context - Error context
   */
  async handleBrowserRecovery(error, context) {
    try {
      logger.info('Attempting browser session recovery', { context, error: error.message });

      const recoveryPlan = LinkedInErrorHandler.createRecoveryPlan(error, context);

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

  /**
   * Delay execution for specified milliseconds
   * @param {number} ms - Milliseconds to delay
   */
  async delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Find the first element matching any selector in order
   * @param {string[]} selectors - CSS selectors to try in order
   * @param {number} waitTimeout - per-selector timeout in ms
   * @returns {Promise<{ element: any, selector: string }>} found element and selector or nulls
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
   * Wait until any of the provided selectors appears
   * @param {string[]} selectors
   * @param {number} waitTimeout
   * @returns {Promise<{ element: any, selector: string }>} found element and selector or nulls
   */
  async waitForAnySelector(selectors, waitTimeout = 5000) {
    return await this.findElementBySelectors(selectors, waitTimeout);
  }

  /**
   * Perform a human-like click on an element
   * @param {any} page
   * @param {any} element
   */
  async clickElementHumanly(page, element) {
    await element.click();
  }

  /**
   * Clear existing content in a focused input and type text with human-like behavior
   * @param {any} page
   * @param {any} element
   * @param {string} text
   */
  async clearAndTypeText(page, element, text) {
    await element.click();
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Delete');
    await this.typeWithHumanPattern(text, element);
  }

  /**
   * Initialize or get existing browser session
   * @returns {Promise<PuppeteerService>} Browser session instance
   */
  async initializeBrowserSession() {
    try {
      return await this.sessionManager.getInstance({ reinitializeIfUnhealthy: true });
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
   * @returns {Promise<PuppeteerService>} Browser session instance
   */
  async getBrowserSession() {
    return await this.sessionManager.getInstance({ reinitializeIfUnhealthy: false });
  }

  /**
   * Close the browser session
   * @returns {Promise<void>}
   */
  async closeBrowserSession() {
    await this.sessionManager.cleanup();
  }

  /**
   * Check if session is active and healthy
   * @returns {Promise<boolean>} True if session is active
   */
  async isSessionActive() {
    return await this.sessionManager.isSessionHealthy();
  }

  /**
   * Get comprehensive session status
   * @returns {Promise<Object>} Session status details
   */
  async getSessionStatus() {
    const sessionHealth = await this.sessionManager.getHealthStatus();
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
   * @returns {Promise<Object>} Suspicious activity analysis and actions taken
   */
  async checkSuspiciousActivity() {
    return { isSuspicious: false, patterns: [], recommendation: '' };
  }

  /**
   * Wait for LinkedIn page to fully load
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
   * Type text with human-like patterns including variable speed and pauses
   * @param {string} text - Text to type
   * @param {Object} element - Optional target element
   * @returns {Promise<void>}
   */
  async typeWithHumanPattern(text, element = null) {
    const session = await this.getBrowserSession();
    const page = session.getPage();
    if (element) {
      await element.type(text);
    } else {
      await page.keyboard.type(text);
    }
  }

  /**
   * Validate workflow parameters before execution
   * @param {string} workflowType - Type of workflow to validate
   * @param {Object} params - Workflow parameters
   * @returns {Object} Validation result
   */
  validateWorkflowParameters(workflowType, params) {
    const validation = {
      isValid: true,
      errors: [],
      warnings: [],
    };

    switch (workflowType) {
      case 'messaging':
        if (!params.recipientProfileId) {
          validation.errors.push('recipientProfileId is required for messaging workflow');
        }
        if (!params.messageContent || params.messageContent.trim().length === 0) {
          validation.errors.push('messageContent is required and cannot be empty');
        }
        if (params.messageContent && params.messageContent.length > 8000) {
          validation.warnings.push('Message content is very long and may be truncated by LinkedIn');
        }
        break;

      case 'connection':
        if (!params.profileId) {
          validation.errors.push('profileId is required for connection workflow');
        }
        if (params.connectionMessage && params.connectionMessage.length > 300) {
          validation.warnings.push('Connection message is very long and may be truncated');
        }
        break;

      case 'post':
        if (!params.content || params.content.trim().length === 0) {
          validation.errors.push('content is required for post creation workflow');
        }
        if (params.content && params.content.length > 3000) {
          validation.warnings.push('Post content is very long and may be truncated by LinkedIn');
        }
        if (params.mediaAttachments && params.mediaAttachments.length > 9) {
          validation.warnings.push(
            'LinkedIn typically supports up to 9 media attachments per post'
          );
        }
        break;

      case 'batch':
        if (!params.operations || !Array.isArray(params.operations)) {
          validation.errors.push('operations array is required for batch workflow');
        }
        if (params.operations && params.operations.length === 0) {
          validation.errors.push('operations array cannot be empty');
        }
        if (params.operations && params.operations.length > 50) {
          validation.warnings.push(
            'Large batch operations may take significant time and increase detection risk'
          );
        }
        break;

      default:
        validation.errors.push(`Unknown workflow type: ${workflowType}`);
    }

    validation.isValid = validation.errors.length === 0;
    return validation;
  }
}
