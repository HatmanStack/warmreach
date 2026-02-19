import { logger } from '#utils/logger.js';
import LinkedInErrorHandler from '../utils/linkedinErrorHandler.js';
import ConfigManager from '#shared-config/configManager.js';
import config from '#shared-config/index.js';
import DynamoDBService from '../../storage/services/dynamoDBService.js';
import { BrowserSessionManager } from '../../session/services/browserSessionManager.js';
import { LinkedInNavigationService } from '../../navigation/services/linkedinNavigationService.js';
import { LinkedInMessagingService } from '../../messaging/services/linkedinMessagingService.js';
import { LinkedInConnectionService } from '../../connections/services/linkedinConnectionService.js';
import { LinkedInMessageScraperService } from '../../messaging/services/linkedinMessageScraperService.js';

const RandomHelpers = {
  /**
   * Wait for a random duration between minMs and maxMs
   */
  async randomDelay(minMs = 300, maxMs = 800) {
    try {
      const span = Math.max(0, maxMs - minMs);
      const delayMs = minMs + Math.floor(Math.random() * (span + 1));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } catch {
      // No-op on failure
    }
  },
};

/**
 * LinkedIn Interaction Service - Main service class for LinkedIn automation.
 *
 * Supports dependency injection for testing via constructor options.
 * All dependencies default to production implementations when not provided.
 */
export class LinkedInInteractionService {
  /**
   * Create a new LinkedInInteractionService.
   * @param {Object} options - Optional dependencies for testing
   * @param {Object} options.sessionManager - Session manager (defaults to BrowserSessionManager)
   * @param {Object} options.configManager - Config manager (defaults to ConfigManager)
   * @param {Object} options.dynamoDBService - DynamoDB service instance
   * @param {Object} options.humanBehavior - Human behavior simulator (defaults to no-op)
   * @param {Object} options.controlPlaneService - Control plane service (defaults to no-op)
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

    // Initialize domain services (facade pattern)
    this.navigationService =
      options.navigationService ||
      new LinkedInNavigationService({
        sessionManager: this.sessionManager,
        configManager: this.configManager,
      });

    this.messagingService =
      options.messagingService ||
      new LinkedInMessagingService({
        sessionManager: this.sessionManager,
        navigationService: this.navigationService,
        dynamoDBService: this.dynamoDBService,
      });

    this.connectionService =
      options.connectionService ||
      new LinkedInConnectionService({
        sessionManager: this.sessionManager,
        navigationService: this.navigationService,
        dynamoDBService: this.dynamoDBService,
      });

    this.messageScraperService =
      options.messageScraperService ||
      new LinkedInMessageScraperService({
        sessionManager: this.sessionManager,
      });

    // Get configuration values
    const errorConfig = this.configManager.getErrorHandlingConfig();
    this.maxRetries = errorConfig.retryAttempts;
    this.baseRetryDelay = errorConfig.retryBaseDelay;

    // Rate-limit action log for _enforceRateLimit()
    this._actionLog = [];

    logger.debug('LinkedInInteractionService initialized as facade', {
      maxRetries: this.maxRetries,
      baseRetryDelay: this.baseRetryDelay,
      injectedDependencies: Object.keys(options).length > 0,
      domainServices: ['navigation', 'messaging', 'connection'],
    });
  }

  /**
   * Execute a callback after a random delay. The delay is integral to the
   * return path — removing it breaks the function.
   */
  async _paced(minMs, maxMs, fn) {
    await RandomHelpers.randomDelay(minMs, maxMs);
    return await fn();
  }

  /**
   * Enforce hard-coded rate limits. Constants are literal values — not imported
   * from config, not overrideable via env vars.
   */
  _enforceRateLimit() {
    const now = Date.now();
    this._actionLog = this._actionLog.filter((t) => now - t < 86400000);
    const lastMin = this._actionLog.filter((t) => now - t < 60000).length;
    const lastHour = this._actionLog.filter((t) => now - t < 3600000).length;
    if (lastMin >= 15 || lastHour >= 200 || this._actionLog.length >= 500)
      throw new Error('Rate limit exceeded');
    this._actionLog.push(now);
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
        // Merge CP limits into configManager — CP can only tighten, not loosen
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
    // Disable retries for interactive flows; execute once
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

      // Get recovery plan
      const recoveryPlan = LinkedInErrorHandler.createRecoveryPlan(error, context);

      if (recoveryPlan.shouldRecover) {
        // Execute recovery actions
        logger.info('Executing browser recovery plan', {
          actions: recoveryPlan.actions,
          delay: recoveryPlan.delay,
        });

        // Cleanup and reinitialize browser session
        await BrowserSessionManager.cleanup();
        await BrowserSessionManager.getInstance({ reinitializeIfUnhealthy: true });

        logger.info('Browser session recovery completed');
      }
    } catch (recoveryError) {
      logger.error('Browser recovery failed', {
        originalError: error.message,
        recoveryError: recoveryError.message,
      });
      // Don't throw here, let the retry mechanism handle it
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
   * Perform a human-like click on an element (scroll into view, move mouse, think, click)
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
      throw new Error(`Browser session initialization failed: ${error.message}`);
    }
  }

  /**
   * Get the current browser session
   * @returns {Promise<PuppeteerService>} Browser session instance
   */
  async getBrowserSession() {
    // Avoid triggering automatic browser reinitialization during normal operations like selector checks.
    // We will explicitly reinitialize only via initializeBrowserSession() or recovery handlers.
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
    const suspiciousActivity = { isSuspicious: false, patterns: [], recommendation: '' };

    if (suspiciousActivity.isSuspicious) {
      logger.warn('Suspicious activity detected, applying enhanced cooling-off period', {
        patterns: suspiciousActivity.patterns,
        recommendation: suspiciousActivity.recommendation,
      });

      // Cooling off disabled
    }

    return suspiciousActivity;
  }

  /**
   * Navigate to a LinkedIn profile
   * @param {string} profileId - LinkedIn profile identifier
   * @returns {Promise<boolean>} True if navigation successful
   */
  /**
   * Navigate to a LinkedIn profile page
   * Implements requirements 1.3, 2.2
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
      // Extra stabilization wait using a lightweight heuristic
      try {
        await this.waitForPageStability?.();
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

      // Screenshot capture removed

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
      // Look for profile-specific elements
      // Prioritize data-view-name (stable) over class names (obfuscated)
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
   * Wait for LinkedIn page to fully load
   * @returns {Promise<void>}
   */
  async waitForLinkedInLoad() {
    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();

      // Heuristic hydration/stability detector for SPA pages (avoids flaky networkidle)
      const maxWaitMs = this.configManager.get('pageLoadMaxWait', 10000);
      const sampleIntervalMs = 250;
      const requiredStableSamples = 3;

      let lastMetrics = null;
      let stableSamples = 0;
      const startTs = Date.now();

      while (Date.now() - startTs < maxWaitMs) {
        const metrics = await page.evaluate(() => {
          const ready = document.readyState; // 'loading' | 'interactive' | 'complete'
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

        // Fast path: base UI present and DOM not loading
        const baseUiPresent =
          (metrics.main || metrics.scaffold || metrics.nav) && metrics.ready !== 'loading';

        // Stability: DOM metrics not changing over a few samples
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
        session.waitForSelector('main', { timeout: 2000 }),
        session.waitForSelector('.scaffold-layout', { timeout: 2000 }),
        session.waitForSelector('[data-test-id]', { timeout: 2000 }),
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
   * Send a direct message to a LinkedIn connection
   * @param {string} recipientProfileId - Profile ID of message recipient
   * @param {string} messageContent - Message content to send
   * @param {string} userId - ID of authenticated user
   * @returns {Promise<Object>} Message result
   */
  async sendMessage(recipientProfileId, messageContent, userId) {
    const context = {
      operation: 'sendMessage',
      recipientProfileId,
      messageLength: messageContent.length,
      userId,
    };

    logger.info(
      `Sending LinkedIn message to profile ${recipientProfileId} by user ${userId}`,
      context
    );
    this._enforceRateLimit();
    // Apply control plane rate limits (if configured)
    await this._applyControlPlaneRateLimits('sendMessage');

    // Check for suspicious activity before starting
    await this.checkSuspiciousActivity();

    // Get or initialize browser session
    await this.getBrowserSession();

    // Navigate to recipient's profile
    const navigationSuccess = await this.navigateToProfile(recipientProfileId);
    if (!navigationSuccess) {
      throw new Error(`Failed to navigate to profile: ${recipientProfileId}`);
    }

    // Navigate to messaging interface
    await this.navigateToMessaging(recipientProfileId);

    // Compose and send the message
    const messageResult = await this.composeAndSendMessage(messageContent);

    // Update session activity
    this.sessionManager.lastActivity = new Date();

    // Scrape the visible conversation thread and update DynamoDB (fire-and-forget)
    this._scrapeAndStoreConversation(recipientProfileId).catch((err) => {
      logger.warn('Post-send conversation scrape failed (non-blocking)', {
        recipientProfileId,
        error: err.message,
      });
    });

    // Report interaction telemetry (fire-and-forget)
    this._reportInteraction('sendMessage');

    logger.info(`Successfully sent LinkedIn message`, {
      recipientProfileId,
      messageId: messageResult.messageId,
      userId,
    });

    return {
      messageId: messageResult.messageId || `msg_${Date.now()}_${recipientProfileId}`,
      deliveryStatus: 'sent',
      sentAt: new Date().toISOString(),
      recipientProfileId,
      userId,
    };
  }

  /**
   * Scrape the visible conversation thread after sending a message and update DynamoDB.
   * @param {string} profileId - Recipient profile ID
   */
  async _scrapeAndStoreConversation(profileId) {
    try {
      const messages = await this.messageScraperService.scrapeConversationThread(profileId);
      if (messages.length > 0) {
        await this.dynamoDBService.updateMessages(profileId, messages);
        logger.info(`Stored ${messages.length} messages for ${profileId} after send`);
      }
    } catch (error) {
      logger.warn(`Failed to scrape/store conversation for ${profileId}: ${error.message}`);
    }
  }

  /**
   * Navigate to LinkedIn messaging interface for a specific profile
   * @param {string} profileId - Profile ID to message
   * @returns {Promise<void>}
   */
  /**
   * Navigate to messaging interface for a specific profile
   * Implements requirements 1.2, 1.3
   * @param {string} profileId - LinkedIn profile ID
   * @returns {Promise<void>}
   */
  async navigateToMessaging(profileId) {
    logger.info(`Navigating to messaging interface for profile: ${profileId}`);

    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();

      // Add human-like delay before interaction

      // Look for message button on profile page
      // Prioritize data-view-name (stable) over data-test-id (removed by LinkedIn)
      const messageButtonSelectors = [
        '[data-view-name="message-button"]',
        '[aria-label="Message"]',
        'button[aria-label*="Message"]',
        'button[aria-label*="message"]',
        'a[href*="/messaging/"]',
        '[data-test-id="message-button"]',
      ];
      const { element: messageButton, selector: foundSelector } = await this.findElementBySelectors(
        messageButtonSelectors,
        3000
      );

      if (messageButton) {
        // Scroll button into view if needed
        await this.clickElementHumanly(page, messageButton);

        // Wait for messaging interface to load
        await this.waitForMessagingInterface();
      } else {
        // Fallback: Try navigating directly to messaging URL with recipient
        const messagingUrl = `${config.linkedin.baseUrl}/messaging/thread/new?recipient=${encodeURIComponent(profileId)}`;
        logger.info(`Message button not found, navigating to new thread: ${messagingUrl}`);

        const navigationTimeout = this.configManager.get('navigationTimeout', 30000);
        await session.goto(messagingUrl, {
          waitUntil: 'networkidle',
          timeout: navigationTimeout,
        });

        await this.waitForMessagingInterface();
      }

      // Record the messaging navigation action
      this.humanBehavior.recordAction('messaging_navigation', {
        profileId,
        method: messageButton ? 'button_click' : 'direct_url',
        selector: foundSelector,
        timestamp: new Date().toISOString(),
      });

      logger.info(`Successfully navigated to messaging interface for profile: ${profileId}`);
    } catch (error) {
      logger.error(`Failed to navigate to messaging interface for ${profileId}:`, error);

      // Screenshot capture removed

      throw new Error(`Messaging navigation failed: ${error.message}`);
    }
  }

  /**
   * Wait for messaging interface to load
   * @returns {Promise<void>}
   */
  async waitForMessagingInterface() {
    try {
      await this.getBrowserSession();

      // Wait for messaging interface elements
      // Prioritize role/contenteditable (semantic) over class names (obfuscated)
      const messagingSelectors = [
        '[contenteditable="true"][role="textbox"]',
        '[role="textbox"]',
        '[data-view-name*="messaging"]',
        '[data-test-id="message-input"]',
      ];
      const { element: messagingElement } = await this.waitForAnySelector(messagingSelectors, 5000);

      if (!messagingElement) {
        throw new Error('Messaging interface did not load properly');
      }

      // Additional wait for interface to be fully interactive
    } catch (error) {
      logger.error('Failed to wait for messaging interface:', error);
      throw error;
    }
  }

  /**
   * Compose and send a message in the LinkedIn messaging interface
   * @param {string} messageContent - Message content to send
   * @returns {Promise<Object>} Message result with ID
   */
  /**
   * Compose and send a LinkedIn message
   * Implements requirements 1.2, 1.4
   * @param {string} messageContent - Message content to send
   * @returns {Promise<Object>} Message result with ID
   */
  async composeAndSendMessage(messageContent) {
    logger.info('Composing and sending LinkedIn message', {
      messageLength: messageContent.length,
    });

    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();

      // Wait for messaging interface to be ready
      await this.waitForMessagingInterface();

      // Look for message input field
      // Prioritize semantic selectors over class names
      const messageInputSelectors = [
        '[contenteditable="true"][role="textbox"]',
        '[role="textbox"]',
        '[aria-label*="message" i][contenteditable="true"]',
        '[aria-label*="Write" i][contenteditable="true"]',
        '[data-test-id="message-input"]',
      ];
      const { element: messageInput, selector: foundSelector } = await this.waitForAnySelector(
        messageInputSelectors,
        5000
      );

      if (!messageInput) {
        throw new Error('Message input field not found in messaging interface');
      }

      // Type message with reusable helper
      await this.humanBehavior.simulateHumanMouseMovement(page, messageInput);
      await this.clearAndTypeText(page, messageInput, messageContent);

      // Look for send button (paced delay before interaction)
      // Prioritize aria-label (accessibility) over class names
      const sendButtonSelectors = [
        'button[aria-label*="Send" i]',
        '[aria-label*="Send" i]',
        'button[type="submit"]',
        '[data-test-id="send-button"]',
      ];
      const { element: sendButton, selector: sendSelector } = await this._paced(1000, 2000, () =>
        this.findElementBySelectors(sendButtonSelectors, 3000)
      );

      if (!sendButton) {
        // Try using Enter key as fallback
        logger.info('Send button not found, trying Enter key');
        await page.keyboard.press('Enter');
      } else {
        // Human-like click
        await this.clickElementHumanly(page, sendButton);
      }

      // Wait for message to be sent
      await this.waitForMessageSent();

      // Generate message ID
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Record the message sending action
      this.humanBehavior.recordAction('message_sent', {
        messageLength: messageContent.length,
        inputSelector: foundSelector,
        sendSelector: sendSelector,
        messageId,
        timestamp: new Date().toISOString(),
      });

      logger.info('Successfully composed and sent LinkedIn message', { messageId });

      return {
        messageId,
        sentAt: new Date().toISOString(),
        messageLength: messageContent.length,
      };
    } catch (error) {
      logger.error('Failed to compose and send message:', error);

      // Screenshot capture removed

      throw new Error(`Message composition failed: ${error.message}`);
    }
  }

  /**
   * Wait for message to be sent confirmation
   * @returns {Promise<void>}
   */
  async waitForMessageSent() {
    try {
      const session = await this.getBrowserSession();

      // Wait for message sent indicators
      const sentIndicators = [
        '.msg-s-message-list-item--sent',
        '[data-test-id="message-sent"]',
        '.msg-conversation-card__message--sent',
        '.messaging-conversation-item--sent',
      ];

      let sentConfirmed = false;
      for (const selector of sentIndicators) {
        try {
          const indicator = await session.waitForSelector(selector, { timeout: 5000 });
          if (indicator) {
            logger.debug(`Message sent confirmation found: ${selector}`);
            sentConfirmed = true;
            break;
          }
        } catch {
          // Continue checking other indicators
        }
      }

      if (!sentConfirmed) {
        // Fallback: wait for input to be cleared or send button to be disabled

        logger.debug('Message sent confirmation not found, assuming sent based on timing');
      }
    } catch (error) {
      logger.debug('Message sent confirmation wait completed:', error.message);
      // Don't throw error as message might have been sent successfully
    }
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
   * Send a connection request to a LinkedIn profile
   * @param {string} profileId - Profile ID to connect with
   * @param {string} connectionMessage - Optional connection message
   * @param {string} userId - ID of authenticated user
   * @returns {Promise<Object>} Connection result
   */
  // addConnection removed in favor of executeConnectionWorkflow

  /**
   * Create and publish a LinkedIn post
   * @param {string} content - Post content
   * @param {Array} mediaAttachments - Optional media attachments
   * @param {string} userId - ID of authenticated user
   * @returns {Promise<Object>} Post result
   */
  async createPost(content, mediaAttachments = [], userId) {
    const context = {
      operation: 'createPost',
      contentLength: content.length,
      hasMedia: mediaAttachments.length > 0,
      userId,
    };

    logger.info(`Creating LinkedIn post by user ${userId}`, context);
    this._enforceRateLimit();
    // Apply control plane rate limits (if configured)
    await this._applyControlPlaneRateLimits('createPost');

    // Check for suspicious activity before starting
    await this.checkSuspiciousActivity();

    // Get or initialize browser session
    await this.getBrowserSession();

    // Navigate to post creation interface
    await this.navigateToPostCreator();

    // Compose the post content
    await this.composePost(content);

    // Add media attachments if provided
    if (mediaAttachments && mediaAttachments.length > 0) {
      await this.addMediaAttachments(mediaAttachments);
    }

    // Publish the post
    const postResult = await this.publishPost();

    // Update session activity
    this.sessionManager.lastActivity = new Date();

    // Record the successful post creation
    this.humanBehavior.recordAction('post_created', {
      contentLength: content.length,
      hasMedia: mediaAttachments.length > 0,
      userId,
    });

    // Report interaction telemetry (fire-and-forget)
    this._reportInteraction('createPost');

    logger.info(`Successfully created LinkedIn post`, {
      postId: postResult.postId,
      postUrl: postResult.postUrl,
      userId,
    });

    return {
      postId: postResult.postId || `post_${Date.now()}_${userId}`,
      postUrl: postResult.postUrl,
      publishStatus: 'published',
      publishedAt: new Date().toISOString(),
      userId,
    };
  }

  /**
   * Navigate to LinkedIn post creation interface
   * @returns {Promise<void>}
   */
  /**
   * Navigate to LinkedIn post creation interface
   * Implements requirements 3.2, 3.3
   * @returns {Promise<void>}
   */
  async navigateToPostCreator() {
    logger.info('Navigating to LinkedIn post creation interface');

    try {
      const session = await this.getBrowserSession();

      // Navigate to LinkedIn home/feed page first
      const navigationTimeout = this.configManager.get('navigationTimeout', 30000);
      await session.goto(`${config.linkedin.baseUrl}/feed/`, {
        waitUntil: 'networkidle',
        timeout: navigationTimeout,
      });

      await this.waitForLinkedInLoad();

      // Add human-like navigation delay

      // Look for "Start a post" button or similar
      // Prioritize aria-label (accessibility) over class names
      const startPostSelectors = [
        'button[aria-label*="Start a post" i]',
        '[aria-label*="Start a post" i]',
        'div[data-placeholder*="Start a post" i]',
        '[data-test-id="start-post-button"]',
      ];

      let startPostButton = null;

      // Try to find start post button with multiple selectors
      for (const selector of startPostSelectors) {
        try {
          startPostButton = await session.waitForSelector(selector, { timeout: 5000 });
          if (startPostButton) {
            logger.debug(`Found start post button with selector: ${selector}`);
            break;
          }
        } catch (err) {
          logger.debug(`Selector failed for start post button: ${selector}`, {
            error: err.message,
          });
          // Continue to next selector
        }
      }

      if (!startPostButton) {
        throw new Error('Start post button not found on LinkedIn feed');
      }

      // Move to button

      // Add thinking delay before clicking

      // Click the start post button
      logger.info('Clicking start post button');
      await startPostButton.click();

      // Wait for post creation interface to load
      await this.waitForPostCreationInterface();

      // Telemetry removed

      logger.info('Successfully navigated to post creation interface');
    } catch (error) {
      logger.error('Failed to navigate to post creation interface:', error);

      // Screenshot capture removed

      throw new Error(`Post creator navigation failed: ${error.message}`);
    }
  }

  /**
   * Wait for post creation interface to load
   * @returns {Promise<void>}
   */
  async waitForPostCreationInterface() {
    try {
      const session = await this.getBrowserSession();

      // Wait for post creation interface elements
      // Prioritize semantic/accessibility selectors
      const postCreationSelectors = [
        '[contenteditable="true"][role="textbox"]',
        '[aria-label*="Text editor" i]',
        '[aria-label*="talk about" i]',
        'div[data-placeholder*="talk about" i]',
        '[data-test-id="post-content-input"]',
      ];

      let postCreationElement = null;
      for (const selector of postCreationSelectors) {
        try {
          postCreationElement = await session.waitForSelector(selector, { timeout: 8000 });
          if (postCreationElement) {
            logger.debug(`Post creation interface loaded, found element: ${selector}`);
            break;
          }
        } catch {
          // Continue to next selector
        }
      }

      if (!postCreationElement) {
        throw new Error('Post creation interface did not load properly');
      }

      // Additional wait for interface to be fully interactive
    } catch (error) {
      logger.error('Failed to wait for post creation interface:', error);
      throw error;
    }
  }

  /**
   * Compose post content in the LinkedIn post creator
   * @param {string} content - Post content to compose
   * @returns {Promise<void>}
   */
  async composePost(content) {
    logger.info('Composing LinkedIn post content', {
      contentLength: content.length,
    });

    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();

      // Wait for post creation interface to be ready
      await this.waitForLinkedInLoad();

      // Look for post content input field
      const contentInputSelectors = [
        '[data-test-id="post-content-input"]',
        '.ql-editor[contenteditable="true"]',
        '[contenteditable="true"][role="textbox"]',
        'div[data-placeholder*="What do you want to talk about"]',
        '.share-creation-state__text-editor',
        '[aria-label*="Text editor"]',
      ];

      let contentInput = null;
      for (const selector of contentInputSelectors) {
        try {
          contentInput = await session.waitForSelector(selector, { timeout: 3000 });
          if (contentInput) {
            logger.debug(`Found content input with selector: ${selector}`);
            break;
          }
        } catch {
          // Continue to next selector
        }
      }

      if (!contentInput) {
        throw new Error('Post content input field not found');
      }

      // Simulate human mouse movement to input field
      await this.humanBehavior.simulateHumanMouseMovement(page, contentInput);

      // Clear any existing content and focus on input
      await contentInput.click();

      // Clear existing content
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');

      await page.keyboard.press('Delete');

      // Type post content with human-like typing pattern
      await this.typeWithHumanPattern(content, contentInput);

      // Add delay after typing

      logger.info('Post content composed successfully');
    } catch (error) {
      logger.error('Failed to compose post content:', error);
      throw new Error(`Post composition failed: ${error.message}`);
    }
  }

  /**
   * Add media attachments to the post
   * Implements requirement 3.4 - Media attachment support
   * @param {Array} mediaAttachments - Array of media attachments with file paths and types
   * @returns {Promise<void>}
   */
  async addMediaAttachments(mediaAttachments) {
    logger.info('Adding media attachments to post', {
      attachmentCount: mediaAttachments.length,
    });

    try {
      if (!mediaAttachments || mediaAttachments.length === 0) {
        logger.debug('No media attachments to add');
        return;
      }

      const session = await this.getBrowserSession();
      const page = session.getPage();

      // Look for media attachment button
      const mediaButtonSelectors = [
        '[data-test-id="media-upload-button"]',
        '[aria-label*="Add media"]',
        '[aria-label*="Add photo"]',
        '.share-actions__primary-action button[aria-label*="media"]',
        'button[data-control-name="add_media"]',
        '.media-upload-button',
        'input[type="file"][accept*="image"]',
        'button[aria-label*="Upload"]',
      ];

      let mediaButton = null;
      for (const selector of mediaButtonSelectors) {
        try {
          mediaButton = await session.waitForSelector(selector, { timeout: 2000 });
          if (mediaButton) {
            logger.debug(`Found media button with selector: ${selector}`);
            break;
          }
        } catch {
          // Continue to next selector
        }
      }

      if (!mediaButton) {
        logger.warn('Media upload button not found, skipping media attachments');
        return;
      }

      // Process each media attachment
      for (let i = 0; i < mediaAttachments.length; i++) {
        const attachment = mediaAttachments[i];
        logger.info(`Processing media attachment ${i + 1}/${mediaAttachments.length}`, {
          type: attachment.type,
          filename: attachment.filename,
        });

        // Simulate human mouse movement to media button
        await this.humanBehavior.simulateHumanMouseMovement(page, mediaButton);

        // Click media upload button
        await mediaButton.click();

        // Handle file upload (if file path provided)
        if (attachment.filePath) {
          try {
            // Look for file input element
            const fileInput = await session.waitForSelector('input[type="file"]', {
              timeout: 5000,
            });
            if (fileInput) {
              await fileInput.uploadFile(attachment.filePath);
              logger.debug(`Uploaded file: ${attachment.filePath}`);

              // Wait for upload to process
            }
          } catch (uploadError) {
            logger.warn(`Failed to upload file ${attachment.filePath}:`, uploadError.message);
          }
        }

        // Add delay between attachments
        if (i < mediaAttachments.length - 1) {
        }
      }

      // Record successful media attachment
      this.humanBehavior.recordAction('media_attached', {
        attachmentCount: mediaAttachments.length,
        types: mediaAttachments.map((a) => a.type),
      });

      logger.info('Media attachments added successfully');
    } catch (error) {
      logger.error('Failed to add media attachments:', error);

      // Record failed attempt
      this.humanBehavior.recordAction('media_attachment_failed', {
        attachmentCount: mediaAttachments.length,
        error: error.message,
      });

      throw new Error(`Media attachment failed: ${error.message}`);
    }
  }

  /**
   * Send the connection request after clicking connect button
   * Implements requirement 2.4 - Connection request workflow
   * This still isn't sending notification if the user is already connected to the profile
   * Although the backend is recording the edge, the frontend is not updating the connection status
   * @returns {Promise<Object>} Connection request result
   */
  async sendConnectionRequest(profileId, jwtToken) {
    logger.info('Sending connection request for profile: ' + profileId);
    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();

      // 2. Wait for the modal to appear and be visible.
      const modalSelector = '[role="dialog"], .artdeco-modal, .send-invite';
      const modal = await page.waitForSelector(modalSelector, { visible: true, timeout: 5000 });
      if (!modal) {
        throw new Error('Connection request modal did not appear.');
      }
      logger.info('Connection modal appeared.');

      // 3. Find the clickable "Send" button within the modal using DOM evaluation (Puppeteer-agnostic)
      const sendHandle = await page.evaluateHandle((modalEl) => {
        const lower = (s) => (s || '').toLowerCase();
        const nodes = modalEl.querySelectorAll('button, [role="button"]');
        for (const n of nodes) {
          const aria = lower(n.getAttribute('aria-label'));
          const txt = lower((n.innerText || n.textContent || '').trim());
          if (
            aria.includes('send without a note') ||
            txt === 'send without a note' ||
            aria.includes('send invitation') ||
            txt === 'send invitation' ||
            txt === 'send' ||
            aria === 'send'
          ) {
            return n;
          }
        }
        return null;
      }, modal);

      const sendButton = sendHandle?.asElement?.();
      if (!sendButton) {
        throw new Error('Send button not found within the modal.');
      }

      // 4. Click the button and wait for confirmation.
      await this.humanBehavior.simulateHumanMouseMovement(page, sendButton);
      await sendButton.click();
      logger.info('Clicked send button in modal.');

      const confirmationSelectors = [
        '.artdeco-toast-item',
        'button[aria-label*="Pending"]',
        '[data-test-id="invitation-sent-confirmation"]',
      ];
      await page.waitForSelector(confirmationSelectors.join(', '), { timeout: 5000 });

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
      throw new Error(`Connection request failed: ${error.message}`);
    }
  }

  /**
   * Check the current connection status with a profile
   * @returns {Promise<string>} Connection status: 'connected', 'pending', 'not_connected'
   */
  async checkConnectionStatus() {
    try {
      const session = await this.getBrowserSession();

      // Look for indicators of existing connection
      // Prioritize data-view-name and aria-label over class names
      const connectedSelectors = [
        '[data-view-name="message-button"]',
        '[aria-label="Message"]',
        'button[aria-label*="Message" i]',
        '[data-test-id="message-button"]',
      ];

      const pendingSelectors = [
        '[aria-label*="Pending" i]',
        'button[aria-label*="Pending" i]',
        '[data-test-id="pending-button"]',
      ];

      // Check for message button (indicates already connected)
      for (const selector of connectedSelectors) {
        try {
          const element = await session.waitForSelector(selector, { timeout: 1000 });
          if (element) {
            logger.debug(`Found connection indicator: ${selector}`);
            return 'connected';
          }
        } catch {
          // Continue checking
        }
      }

      // Check for pending connection
      for (const selector of pendingSelectors) {
        try {
          const element = await session.waitForSelector(selector, { timeout: 1000 });
          if (element) {
            logger.debug(`Found pending connection indicator: ${selector}`);
            return 'pending';
          }
        } catch {
          // Continue checking
        }
      }

      return 'not_connected';
    } catch (error) {
      logger.error('Failed to check connection status:', error);
      return 'not_connected'; // Default to not connected on error
    }
  }

  /**
   * Check if the profile page container contains an aria-label with "Pending"
   * If true, caller should treat connection as already pending/outgoing
   * @returns {Promise<boolean>}
   */
  async isProfileContainer(buttonName) {
    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();
      // Try broader, stable containers in priority order
      const candidateSelectors = [
        '#profile-content main section.artdeco-card div.ph5.pb5',
        '#profile-content main section.artdeco-card',
        '#profile-content main',
        'main .pv-top-card',
        'main',
      ];

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
            return new RegExp(
              `aria[-\\s]?label\\s*=\\s*["'][^"']*${buttonName}[^"']*["']`,
              'i'
            ).test(html);
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
        const handle = await page.evaluateHandle((root) => {
          const lower = (s) => (s || '').toLowerCase();
          const isVisible = (n) => {
            const r = n.getBoundingClientRect();
            const s = window.getComputedStyle(n);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          };
          const nodes = root.querySelectorAll('button,[role="button"],.artdeco-button');
          for (const n of nodes) {
            const aria = lower(n.getAttribute('aria-label'));
            const txt = lower((n.innerText || n.textContent || '').trim());
            if (((aria && aria.includes('connect')) || txt === 'connect') && isVisible(n)) return n;
          }
          return null;
        }, container);
        const btn = handle && handle.asElement && handle.asElement();
        if (btn) {
          await this.clickElementHumanly(page, btn);
          return true;
        }
        return false;
      } else if (buttonName === 'more') {
        const handle = await page.evaluateHandle((root) => {
          const lower = (s) => (s || '').toLowerCase();
          const isVisible = (n) => {
            const r = n.getBoundingClientRect();
            const s = window.getComputedStyle(n);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          };
          const nodes = root.querySelectorAll('button,[role="button"],.artdeco-button');
          for (const n of nodes) {
            const aria = lower(n.getAttribute('aria-label'));
            const txt = lower((n.innerText || n.textContent || '').trim());
            if (((aria && aria.includes('more')) || txt === 'more') && isVisible(n)) return n;
          }
          return null;
        }, container);
        const btn = handle && handle.asElement && handle.asElement();
        if (btn) {
          await this.clickElementHumanly(page, btn);
          return true;
        }
        return false;
      } else {
        throw new Error(`Invalid button name: ${buttonName}`);
      }
    } catch (error) {
      logger.debug('Pending container check failed:', error.message);
      return false;
    }
  }

  /**
   * Ensure an edge is recorded for the profile using edge manager
   * @param {string} profileId - Profile ID to record edge for
   * @param {string} status - Edge status (e.g., 'outgoing', 'pending', 'connected')
   * @param {string|undefined} jwtToken - JWT token for authentication
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

  /**
   * Input post content with realistic typing patterns and delays
   * @param {string} content - Post content to input
   * @returns {Promise<void>}
   */
  async inputPostContent(content) {
    logger.info('Inputting post content', {
      contentLength: content.length,
    });

    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();

      // Wait for post creation interface to be ready
      await this.waitForLinkedInLoad();

      // Look for post content input field
      const contentInputSelectors = [
        '[data-test-id="post-content-input"]',
        '.ql-editor[contenteditable="true"]',
        '[contenteditable="true"][role="textbox"]',
        'div[data-placeholder*="What do you want to talk about"]',
        '.share-creation-state__text-editor',
        '[aria-label*="Text editor"]',
        '.mentions-texteditor__content',
      ];
      const { element: contentInput } = await this.findElementBySelectors(
        contentInputSelectors,
        3000
      );

      if (!contentInput) {
        throw new Error('Post content input field not found');
      }

      // Clear existing content and type
      await this.clearAndTypeText(page, contentInput, content);

      // Add delay after typing

      logger.info('Post content input completed successfully');
    } catch (error) {
      logger.error('Failed to input post content:', error);
      throw new Error(`Post content input failed: ${error.message}`);
    }
  }

  /**
   * Attach media files to the post (placeholder implementation)
   * @param {Array} mediaAttachments - Array of media attachment objects
   * @returns {Promise<void>}
   */
  async attachMediaToPost(mediaAttachments) {
    logger.info('Attaching media to post', {
      mediaCount: mediaAttachments.length,
    });

    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();

      // Add human-like delay before media interaction

      // Look for media attachment button
      const mediaButtonSelectors = [
        '[data-test-id="media-button"]',
        'button[aria-label*="Add media"]',
        'button[aria-label*="add media"]',
        '.share-actions-control-button[aria-label*="media"]',
        'button[data-control-name*="media"]',
        '.media-upload-button',
      ];
      const { element: mediaButton } = await this.findElementBySelectors(
        mediaButtonSelectors,
        2000
      );

      if (!mediaButton) {
        logger.warn('Media attachment button not found, skipping media upload');
        return;
      }

      // Click media button (paced delay after interaction)
      logger.info('Clicking media attachment button');
      await this._paced(1000, 2000, () => this.clickElementHumanly(page, mediaButton));

      // For now, this is a placeholder implementation
      // In a full implementation, you would:
      // 1. Handle file upload dialogs
      // 2. Upload each media file
      // 3. Wait for upload completion
      // 4. Handle different media types (image, video, document)

      logger.warn('Media attachment functionality is placeholder - files not actually uploaded');

      // Simulate upload delay
    } catch (error) {
      logger.error('Failed to attach media to post:', error);
      // Don't throw error - post can still be published without media
      logger.warn('Proceeding with post creation without media attachments');
    }
  }

  /**
   * Publish the post and wait for confirmation
   * @returns {Promise<Object>} Post result with ID and URL
   */
  async publishPost() {
    logger.info('Publishing LinkedIn post');

    try {
      const session = await this.getBrowserSession();
      const page = session.getPage();

      // Add human-like delay before publishing

      // Look for publish/post button
      const publishButtonSelectors = [
        'button[aria-label*="Post"]',
        'button[aria-label*="post"]',
        '[data-test-id="post-button"]',
        '.share-actions__primary-action',
        'button[data-control-name*="share.post"]',
        'button:has-text("Post")',
        'button[type="submit"]',
      ];
      const { element: publishButton } = await this.findElementBySelectors(
        publishButtonSelectors,
        3000
      );

      if (!publishButton) {
        throw new Error('Publish button not found');
      }

      // Check if publish button is enabled
      const isDisabled = await publishButton.getAttribute('disabled');
      if (isDisabled) {
        throw new Error('Publish button is disabled - post may be incomplete');
      }

      // Click publish button
      logger.info('Clicking publish button');
      await this.clickElementHumanly(page, publishButton);

      // Wait for post to be published (look for confirmation or redirect)

      // Try to extract post URL from current page or notifications
      let postUrl = null;
      try {
        const currentUrl = await page.url();
        if (currentUrl.includes('/posts/') || currentUrl.includes('/activity-')) {
          postUrl = currentUrl;
        }
      } catch {
        logger.debug('Could not extract post URL from current page');
      }

      // Generate post ID for tracking
      const postId = `post_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Generate fallback post URL if not extracted
      if (!postUrl) {
        postUrl = `https://linkedin.com/posts/activity-${Date.now()}`;
      }

      logger.info('Post published successfully', {
        postId,
        postUrl,
      });

      return {
        postId,
        postUrl,
        publishedAt: new Date().toISOString(),
        status: 'published',
      };
    } catch (error) {
      logger.error('Failed to publish post:', error);
      throw new Error(`Post publishing failed: ${error.message}`);
    }
  }

  /**
   * Create and publish a LinkedIn post (combined method)
   * Implements requirements 3.2, 3.3, 3.4
   * @param {string} content - Post content
   * @param {Array} mediaAttachments - Optional media attachments
   * @returns {Promise<Object>} Post result with ID and URL
   */
  async createAndPublishPost(content, mediaAttachments = []) {
    logger.info('Creating and publishing LinkedIn post', {
      contentLength: content.length,
      hasMedia: mediaAttachments.length > 0,
      mediaCount: mediaAttachments.length,
    });

    try {
      await this.getBrowserSession();

      // Check for cooling-off period before starting
      await this.humanBehavior.checkAndApplyCooldown();

      // Step 1: Navigate to post creation interface
      await this.navigateToPostCreator();

      // Step 2: Compose the post content
      await this.composePost(content);

      // Step 3: Add media attachments if provided
      if (mediaAttachments && mediaAttachments.length > 0) {
        await this.addMediaAttachments(mediaAttachments);
      }

      // Step 4: Publish the post
      const postResult = await this.publishPost();

      // Record the successful post creation
      this.humanBehavior.recordAction('post_created', {
        contentLength: content.length,
        hasMedia: mediaAttachments.length > 0,
        mediaCount: mediaAttachments.length,
      });

      logger.info('Successfully created and published LinkedIn post', {
        postId: postResult.postId,
        postUrl: postResult.postUrl,
      });

      return {
        postId: postResult.postId || `post_${Date.now()}`,
        postUrl: postResult.postUrl,
        publishStatus: 'published',
        publishedAt: new Date().toISOString(),
        contentLength: content.length,
        mediaCount: mediaAttachments.length,
      };
    } catch (error) {
      logger.error('Failed to create and publish LinkedIn post:', error);

      // Record failed action for human behavior tracking
      this.humanBehavior.recordAction('post_failed', {
        contentLength: content.length,
        error: error.message,
      });

      throw error;
    }
  }

  /**
   * Complete LinkedIn messaging workflow
   * Implements requirements 1.2, 1.3, 1.4 - End-to-end messaging
   * @param {string} recipientProfileId - Profile ID of message recipient
   * @param {string} messageContent - Message content to send
   * @param {Object} options - Additional options for messaging
   * @returns {Promise<Object>} Complete messaging result
   */
  async executeMessagingWorkflow(recipientProfileId, messageContent, options = {}) {
    const context = {
      operation: 'executeMessagingWorkflow',
      recipientProfileId,
      messageLength: messageContent.length,
      options,
      startTime: Date.now(),
    };

    logger.info('Executing complete LinkedIn messaging workflow', context);
    this._enforceRateLimit();
    // Apply control plane rate limits (if configured)
    await this._applyControlPlaneRateLimits('executeMessagingWorkflow');

    // Step 1: Check for suspicious activity and apply cooling-off
    await this.checkSuspiciousActivity();

    // Step 2: Ensure browser session is healthy
    await this.getBrowserSession();

    // Step 3: Navigate to recipient's profile
    logger.info('Step 1/4: Navigating to profile');
    const navigationSuccess = await this.navigateToProfile(recipientProfileId);
    if (!navigationSuccess) {
      throw new Error(`Failed to navigate to profile: ${recipientProfileId}`);
    }

    // Step 4: Navigate to messaging interface
    logger.info('Step 2/4: Opening messaging interface');
    await this.navigateToMessaging(recipientProfileId);

    // Step 5: Compose and send the message
    logger.info('Step 3/4: Composing and sending message');
    const messageResult = await this.composeAndSendMessage(messageContent);

    // Step 6: Verify message was sent successfully
    logger.info('Step 4/4: Verifying message delivery');
    const deliveryConfirmed = messageResult.deliveryStatus === 'sent';

    // Update session activity and record success
    this.sessionManager.lastActivity = new Date();
    this.humanBehavior.recordAction('messaging_workflow_completed', {
      recipientProfileId,
      messageLength: messageContent.length,
      deliveryConfirmed,
      workflowDuration: Date.now() - context.startTime,
    });

    const result = {
      workflowId: `msg_workflow_${Date.now()}_${recipientProfileId}`,
      messageId: messageResult.messageId || `msg_${Date.now()}_${recipientProfileId}`,
      deliveryStatus: deliveryConfirmed ? 'delivered' : 'sent',
      sentAt: new Date().toISOString(),
      recipientProfileId,
      messageLength: messageContent.length,
      workflowSteps: [
        { step: 'profile_navigation', status: 'completed' },
        { step: 'messaging_interface', status: 'completed' },
        { step: 'message_composition', status: 'completed' },
        { step: 'message_delivery', status: deliveryConfirmed ? 'confirmed' : 'pending' },
      ],
    };

    // Report interaction telemetry (fire-and-forget)
    this._reportInteraction('executeMessagingWorkflow');

    logger.info('LinkedIn messaging workflow completed successfully', result);
    return result;
  }

  /**
   * Create a standardized connection workflow result object
   * @param {string} profileId - Profile ID being connected with
   * @param {string} connectionMessage - Connection message (if any)
   * @param {Object} workflowData - Workflow execution data
   * @returns {Object} Standardized connection workflow result
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
   * Complete LinkedIn connection workflow
   * Implements requirements 2.2, 2.3, 2.4 - End-to-end connection
   * @param {string} profileId - Profile ID to connect with
   * @param {string} connectionMessage - Optional personalized message
   * @param {Object} options - Additional connection options
   * @returns {Promise<Object>} Complete connection result
   */
  async executeConnectionWorkflow(profileId, connectionMessage = '', options = {}) {
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
    // Apply control plane rate limits (if configured)
    await this._applyControlPlaneRateLimits('executeConnectionWorkflow');

    // Step 1: Check for suspicious activity and apply cooling-off
    await this.checkSuspiciousActivity();

    // Step 2: Ensure browser session is healthy
    await this.getBrowserSession();

    // Step 3: Navigate to target profile
    logger.info('Step 1/4: Navigating to profile');
    const navigationSuccess = await this.navigateToProfile(profileId);
    if (!navigationSuccess) {
      throw new Error(`Failed to navigate to profile: ${profileId}`);
    }

    // Step 4: Check current connection status
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

    // Step 5: Find and click connect button
    logger.info('Step 3/4: Clicking connect button');
    const connectButtonFound = await this.isProfileContainer('connect');
    logger.info('Connect button found: ' + connectButtonFound);
    if (!connectButtonFound) {
      const moreButtonFound = await this.isProfileContainer('more');
      if (moreButtonFound) {
        await this.isProfileContainer('connect');
      } else {
        logger.error('Connect button not found in profile container');
        throw new Error('Connect button not found in profile container');
      }
    }

    // Step 6: Send connection request (message addition skipped per requirement)
    logger.info('Step 4/4: Sending connection request');
    const requestResult = await this.sendConnectionRequest(profileId, options?.jwtToken);

    // Update session activity and record success
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

    // Report interaction telemetry (fire-and-forget)
    this._reportInteraction('executeConnectionWorkflow');

    logger.info('LinkedIn connection workflow completed successfully', result);
    return result;
  }

  /**
   * Complete LinkedIn post creation workflow
   * Implements requirements 3.2, 3.3, 3.4 - End-to-end posting
   * @param {string} content - Post content
   * @param {Array} mediaAttachments - Optional media attachments
   * @param {Object} options - Additional posting options
   * @returns {Promise<Object>} Complete post creation result
   */
  async executePostCreationWorkflow(content, mediaAttachments = [], options = {}) {
    const context = {
      operation: 'executePostCreationWorkflow',
      contentLength: content.length,
      hasMedia: mediaAttachments.length > 0,
      mediaCount: mediaAttachments.length,
      options,
      startTime: Date.now(),
    };

    logger.info('Executing complete LinkedIn post creation workflow', context);
    this._enforceRateLimit();

    // Apply control plane rate limits (if configured)
    await this._applyControlPlaneRateLimits('executePostCreationWorkflow');

    // No retries: run once
    // Step 1: Check for suspicious activity and apply cooling-off
    await this.checkSuspiciousActivity();

    // Step 2: Ensure browser session is healthy
    await this.getBrowserSession();

    // Step 3: Navigate to post creation interface
    logger.info('Step 1/5: Opening post creation interface');
    await this.navigateToPostCreator();

    // Step 4: Compose post content
    logger.info('Step 2/5: Composing post content');
    await this.composePost(content);

    // Step 5: Add media attachments if provided
    if (mediaAttachments && mediaAttachments.length > 0) {
      logger.info(`Step 3/5: Adding ${mediaAttachments.length} media attachments`);
      await this.addMediaAttachments(mediaAttachments);
    }

    // Step 6: Review post before publishing (human-like behavior)
    logger.info('Step 4/5: Reviewing post content');

    // Step 7: Publish the post
    logger.info('Step 5/5: Publishing post');
    const postResult = await this.publishPost();

    // Update session activity and record success
    this.sessionManager.lastActivity = new Date();
    this.humanBehavior.recordAction('post_creation_workflow_completed', {
      contentLength: content.length,
      hasMedia: mediaAttachments.length > 0,
      mediaCount: mediaAttachments.length,
      postPublished: postResult.status === 'published',
      workflowDuration: Date.now() - context.startTime,
    });

    const result = {
      workflowId: `post_workflow_${Date.now()}`,
      postId: postResult.postId,
      postUrl: postResult.postUrl,
      publishStatus: postResult.status,
      publishedAt: postResult.publishedAt,
      contentLength: content.length,
      mediaCount: mediaAttachments.length,
      workflowSteps: [
        { step: 'post_interface_navigation', status: 'completed' },
        { step: 'content_composition', status: 'completed' },
        { step: 'media_attachment', status: mediaAttachments.length > 0 ? 'completed' : 'skipped' },
        { step: 'content_review', status: 'completed' },
        {
          step: 'post_publication',
          status: postResult.status === 'published' ? 'confirmed' : 'pending',
        },
      ],
    };

    // Report interaction telemetry (fire-and-forget)
    this._reportInteraction('executePostCreationWorkflow');

    logger.info('LinkedIn post creation workflow completed successfully', result);
    return result;
  }

  // Batch workflow removed: single-operation flows only

  /**
   * Follow a LinkedIn profile
   * Creates an edge with 'followed' status which triggers RAGStack ingestion
   * @param {string} profileId - Profile ID to follow
   * @param {Object} options - Additional options (e.g., jwtToken)
   * @returns {Promise<Object>} Follow result
   */
  async followProfile(profileId, options = {}) {
    const context = {
      operation: 'followProfile',
      profileId,
      options,
    };

    logger.info('Executing LinkedIn follow profile workflow', context);

    try {
      this._enforceRateLimit();
      // Apply control plane rate limits (if configured)
      await this._applyControlPlaneRateLimits('followProfile');

      // Step 1: Check for suspicious activity
      await this.checkSuspiciousActivity();

      // Step 2: Ensure browser session is healthy
      await this.getBrowserSession();

      // Step 3: Navigate to target profile
      logger.info('Step 1/3: Navigating to profile');
      const navigationSuccess = await this.navigateToProfile(profileId);
      if (!navigationSuccess) {
        throw new Error(`Failed to navigate to profile: ${profileId}`);
      }

      // Step 4: Check if already following
      logger.info('Step 2/3: Checking follow status');
      const alreadyFollowing = await this.checkFollowStatus();
      if (alreadyFollowing) {
        logger.info(`Already following profile: ${profileId}`);
        // Ensure edge exists even if already following
        await this.ensureEdge(profileId, 'followed', options?.jwtToken);
        return {
          status: 'already_following',
          profileId,
          followedAt: new Date().toISOString(),
        };
      }

      // Step 5: Find and click follow button
      logger.info('Step 3/3: Clicking follow button');
      const followResult = await this.clickFollowButton(profileId);

      // Step 6: Create edge with 'followed' status (triggers RAGStack ingestion via edge-processing Lambda)
      await this.ensureEdge(profileId, 'followed', options?.jwtToken);

      // Update session activity
      this.sessionManager.lastActivity = new Date();

      // Record the action
      this.humanBehavior.recordAction('profile_followed', {
        profileId,
        timestamp: new Date().toISOString(),
      });

      // Report interaction telemetry (fire-and-forget)
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

      // Record failed action
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

      // Look for indicators that we're already following
      // Prioritize aria-label over class names
      const followingIndicators = [
        '[aria-label*="Following" i]',
        'button[aria-label*="Following" i]',
        '[data-test-id="following-button"]',
      ];

      for (const selector of followingIndicators) {
        try {
          const element = await page.waitForSelector(selector, { timeout: 1000 });
          if (element) {
            logger.debug(`Found following indicator: ${selector}`);
            return true;
          }
        } catch {
          // Continue checking other selectors
        }
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

      // Follow button selectors (in priority order)
      // Prioritize data-view-name and aria-label over class names
      const followButtonSelectors = [
        '[data-view-name="relationship-building-button"]',
        '[aria-label*="Follow" i]:not([aria-label*="Following" i])',
        'button[aria-label*="Follow" i]:not([aria-label*="Following" i])',
        '[data-test-id="follow-button"]',
      ];

      // First try direct follow button
      let followButton = null;
      let foundSelector = null;

      for (const selector of followButtonSelectors) {
        try {
          const element = await page.waitForSelector(selector, { timeout: 2000 });
          if (element) {
            // Verify it's not the "Following" button
            const ariaLabel = await element.getAttribute('aria-label');
            const innerText = await element.innerText();
            if (
              ariaLabel?.toLowerCase().includes('following') ||
              innerText?.toLowerCase().includes('following')
            ) {
              logger.debug(`Skipping 'Following' button with selector: ${selector}`);
              continue;
            }
            followButton = element;
            foundSelector = selector;
            logger.debug(`Found follow button with selector: ${selector}`);
            break;
          }
        } catch {
          // Continue to next selector
        }
      }

      // If not found directly, try via "More" dropdown
      if (!followButton) {
        logger.info('Follow button not found directly, trying More dropdown');
        const moreFound = await this.isProfileContainer('more');
        if (moreFound) {
          // Look for follow option in dropdown (paced delay after More click)
          const dropdownFollowSelectors = [
            'div[role="menu"] button[aria-label*="Follow"]',
            '.artdeco-dropdown__content button[aria-label*="Follow"]',
            '[data-test-id="overflow-menu"] button[aria-label*="Follow"]',
          ];

          for (const selector of dropdownFollowSelectors) {
            try {
              const element = await this._paced(500, 1000, () =>
                page.waitForSelector(selector, { timeout: 2000 })
              );
              if (element) {
                followButton = element;
                foundSelector = selector;
                logger.debug(`Found follow button in dropdown with selector: ${selector}`);
                break;
              }
            } catch {
              // Continue to next selector
            }
          }
        }
      }

      if (!followButton) {
        throw new Error('Follow button not found on profile page');
      }

      // Click the follow button
      await this.clickElementHumanly(page, followButton);
      logger.info(`Clicked follow button for profile: ${profileId}`);

      // Verify follow succeeded by checking for Following indicator (paced delay)
      const followConfirmed = await this._paced(1000, 2000, () => this.checkFollowStatus());

      return {
        status: followConfirmed ? 'followed' : 'pending',
        selector: foundSelector,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`Failed to click follow button for ${profileId}:`, error);
      throw new Error(`Follow button click failed: ${error.message}`);
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
