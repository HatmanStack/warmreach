/**
 * Browser Session Manager - Manages persistent LinkedIn browser sessions.
 *
 * Extracted from LinkedInInteractionService for better separation of concerns
 * and testability via dependency injection.
 */

import { PuppeteerService } from '../../automation/services/puppeteerService.js';
import { logger } from '#utils/logger.js';
import ConfigManager from '#shared-config/configManager.js';
import { SignalDetector } from '../../automation/utils/signalDetector.js';
import { SessionMetrics } from '../../automation/utils/sessionMetrics.js';
import {
  getContentAnalyzer,
  _resetContentAnalyzerForTesting,
} from '../../automation/utils/contentSignalAnalyzer.js';
import { BackoffController } from '../../automation/utils/backoffController.js';
import { linkedInInteractionQueue } from '../../automation/utils/interactionQueue.js';
import { linkedinResolver } from '../../linkedin/selectors/index.js';

/**
 * Browser Session Manager - Singleton class for managing persistent LinkedIn browser sessions.
 *
 * This class manages browser lifecycle, health checking, and session recovery.
 * It uses static properties to maintain singleton behavior for production use,
 * while supporting dependency injection for testing via the factory function.
 */
class BrowserSessionManager {
  static instance = null;
  static lastActivity = null;
  static isAuthenticated = false;
  static sessionStartTime = null;
  static errorCount = 0;
  static configManager = ConfigManager;
  static signalDetector = null;
  static sessionMetrics = null;
  static contentAnalyzer = null;
  static backoffController = null;
  static _initializingPromise = null;

  /**
   * Get maximum errors from configuration.
   * @returns {number}
   */
  static get maxErrors() {
    return this.configManager.getSessionConfig().maxErrors;
  }

  /**
   * Get session timeout from configuration.
   * @returns {number}
   */
  static get sessionTimeout() {
    return this.configManager.getSessionConfig().timeout;
  }

  /**
   * Get the SignalDetector instance.
   * @returns {SignalDetector|null}
   */
  static getSignalDetector() {
    return this.signalDetector;
  }

  /**
   * Get the SessionMetrics instance.
   * @returns {SessionMetrics|null}
   */
  static getSessionMetrics() {
    return this.sessionMetrics;
  }

  /**
   * Get the ContentSignalAnalyzer instance.
   * @returns {ContentSignalAnalyzer|null}
   */
  static getContentAnalyzer() {
    return this.contentAnalyzer;
  }

  /**
   * Get the BackoffController instance.
   * @returns {BackoffController|null}
   */
  static getBackoffController() {
    return this.backoffController;
  }

  /**
   * Get or create the singleton browser session instance.
   * @param {Object} options
   * @param {boolean} options.reinitializeIfUnhealthy - When true, an unhealthy session will be cleaned up and reinitialized
   * @returns {Promise<PuppeteerService>} The browser session instance
   */
  static async getInstance(options = { reinitializeIfUnhealthy: false }) {
    try {
      // Check if existing instance is still valid
      if (this.instance && (await this.isSessionHealthy())) {
        this.lastActivity = new Date();
        logger.debug('Reusing existing browser session');
        return this.instance;
      }

      // If caller does NOT want automatic recovery, just return current instance (may be unhealthy)
      if (this.instance && options && options.reinitializeIfUnhealthy === false) {
        logger.debug(
          'Session reported unhealthy; skipping auto-recovery per options and returning existing instance'
        );
        return this.instance;
      }

      // If initialization is already in progress, await it
      if (this._initializingPromise) {
        logger.debug('Awaiting in-flight browser session initialization');
        return await this._initializingPromise;
      }

      // Start initialization and store the promise
      this._initializingPromise = this._initialize(options);
      try {
        const instance = await this._initializingPromise;
        return instance;
      } finally {
        this._initializingPromise = null;
      }
    } catch (error) {
      logger.error('Failed to get browser session instance:', error);
      this.errorCount++;

      // If we've hit max errors, cleanup and throw
      if (this.errorCount >= this.maxErrors) {
        await this.cleanup();
        throw new Error(
          `Browser session failed after ${this.maxErrors} attempts: ${error.message}`
        );
      }

      throw error;
    }
  }

  /**
   * Internal initialization logic, extracted so getInstance can store the promise.
   * @param {Object} options
   * @returns {Promise<PuppeteerService>}
   */
  static async _initialize(_options) {
    // Clean up any existing unhealthy session before reinitializing
    if (this.instance) {
      logger.info('Cleaning up unhealthy browser session');
      await this.cleanup();
    }

    // Initialize signal detection components
    this.signalDetector = new SignalDetector();
    this.sessionMetrics = new SessionMetrics(this.signalDetector);
    this.contentAnalyzer = getContentAnalyzer(linkedinResolver);

    // Initialize and start backoff controller
    this.backoffController = new BackoffController(this.signalDetector, linkedInInteractionQueue);
    this.backoffController.start();

    // Create new session
    logger.info('Initializing new browser session for LinkedIn interactions');
    this.instance = new PuppeteerService();
    await this.instance.initialize();

    this.sessionStartTime = new Date();
    this.lastActivity = new Date();
    this.isAuthenticated = false;
    this.errorCount = 0;

    logger.info('Browser session initialized successfully');
    return this.instance;
  }

  /**
   * Check if the current session is healthy and responsive.
   * @returns {Promise<boolean>} True if session is healthy
   */
  static async isSessionHealthy() {
    if (!this.instance) {
      return false;
    }

    try {
      const browser = this.instance.getBrowser();
      const page = this.instance.getPage();

      // Check if browser and page exist
      if (!browser || !page) {
        logger.debug('Browser or page is null');
        return false;
      }

      // Check if browser is connected
      if (!browser.isConnected()) {
        logger.debug('Browser is not connected');
        return false;
      }

      // Check if page is not closed
      if (page.isClosed()) {
        logger.debug('Page is closed');
        return false;
      }

      // Try to evaluate a simple expression to test responsiveness
      await page.evaluate(() => document.readyState);

      // Check session timeout
      if (
        this.sessionStartTime &&
        Date.now() - this.sessionStartTime.getTime() > this.sessionTimeout
      ) {
        logger.debug('Session has timed out');
        return false;
      }

      return true;
    } catch (error) {
      logger.debug('Session health check failed:', error.message);
      return false;
    }
  }

  /**
   * Get comprehensive session health information.
   * @returns {Promise<Object>} Session health details
   */
  static async getHealthStatus() {
    const isActive = this.instance !== null;
    const isHealthy = await this.isSessionHealthy();

    return {
      isActive,
      isHealthy,
      isAuthenticated: this.isAuthenticated,
      lastActivity: this.lastActivity,
      sessionAge: this.sessionStartTime ? Date.now() - this.sessionStartTime.getTime() : 0,
      errorCount: this.errorCount,
      memoryUsage: process.memoryUsage(),
      currentUrl: isHealthy && this.instance ? await this.getCurrentUrl() : null,
    };
  }

  /**
   * Get current URL from the browser session.
   * @returns {Promise<string|null>} Current URL or null if unavailable
   */
  static async getCurrentUrl() {
    try {
      if (this.instance && (await this.isSessionHealthy())) {
        const page = this.instance.getPage();
        return await page.url();
      }
    } catch (error) {
      logger.debug('Failed to get current URL:', error.message);
    }
    return null;
  }

  /**
   * Clean up the browser session and reset state.
   * @returns {Promise<void>}
   */
  static async cleanup() {
    try {
      if (this.instance) {
        logger.info('Cleaning up browser session');
        await this.instance.close();
        this.instance = null;
      }

      if (this.signalDetector) {
        this.signalDetector.clear();
      }
      if (this.sessionMetrics) {
        this.sessionMetrics.reset();
      }
      if (this.backoffController) {
        this.backoffController.stop();
        // Intentionally do NOT resume the queue here. If automation was paused
        // due to a detected threat, the pause should survive session recovery so
        // the user must explicitly resume via the tray. Auto-resuming after a
        // threat-triggered shutdown would defeat the purpose of the backoff system.
      }

      this.lastActivity = null;
      this.isAuthenticated = false;
      this.sessionStartTime = null;
      this.errorCount = 0;
      this._initializingPromise = null;

      logger.info('Browser session cleanup completed');
    } catch (error) {
      logger.error('Error during browser session cleanup:', error);
      // Force reset even if cleanup failed
      this.instance = null;
      this.lastActivity = null;
      this.isAuthenticated = false;
      this.sessionStartTime = null;
      this._initializingPromise = null;
    }
  }

  /**
   * Recover from session errors by reinitializing.
   * @returns {Promise<PuppeteerService>} New session instance
   */
  static async recover() {
    logger.info('Attempting session recovery');
    if (this.signalDetector) {
      this.signalDetector.clear();
    }
    if (this.sessionMetrics) {
      this.sessionMetrics.reset();
    }
    await this.cleanup();
    return await this.getInstance({ reinitializeIfUnhealthy: true });
  }

  /**
   * Update authentication status.
   * @param {boolean} authenticated - Whether the session is authenticated with LinkedIn
   */
  static setAuthenticationStatus(authenticated) {
    this.isAuthenticated = authenticated;
    logger.debug(`LinkedIn authentication status updated: ${authenticated}`);
  }

  /**
   * Record an error and check if recovery is needed.
   * @param {Error} error - The error that occurred
   * @returns {Promise<boolean>} True if recovery was attempted
   */
  static async recordError(error) {
    this.errorCount++;
    logger.warn(`Session error recorded (${this.errorCount}/${this.maxErrors}):`, error.message);

    // If we've hit too many errors, attempt recovery
    if (this.errorCount >= this.maxErrors) {
      logger.error('Maximum session errors reached, attempting recovery');
      try {
        await this.recover();
        return true;
      } catch (recoveryError) {
        logger.error('Session recovery failed:', recoveryError);
        throw new Error(
          `Session recovery failed after ${this.maxErrors} errors: ${recoveryError.message}`
        );
      }
    }

    return false;
  }

  /**
   * Reset the session manager for testing purposes.
   * WARNING: Only use in tests.
   */
  static _resetForTesting() {
    this.instance = null;
    this.lastActivity = null;
    this.isAuthenticated = false;
    this.sessionStartTime = null;
    this.errorCount = 0;
    this.signalDetector = null;
    this.sessionMetrics = null;
    this.contentAnalyzer = null;
    this.backoffController = null;
    this._initializingPromise = null;
    _resetContentAnalyzerForTesting();
  }
}

export { BrowserSessionManager };
