// @ts-nocheck -- migrated from .js; full type annotations pending
import { logger } from '#utils/logger.js';
import { LinkedInErrorHandler } from '../utils/linkedinErrorHandler.js';
import ConfigManager from '#shared-config/configManager.js';
import DynamoDBService from '../../storage/services/dynamoDBService.js';
import { BrowserSessionManager } from '../../session/services/browserSessionManager.js';
import { LinkedInNavigationService } from '../../navigation/services/linkedinNavigationService.js';
import { LinkedInMessagingService } from '../../messaging/services/linkedinMessagingService.js';
import { LinkedInConnectionService } from '../../connections/services/linkedinConnectionService.js';
import { LinkedInMessageScraperService } from '../../messaging/services/linkedinMessageScraperService.js';
import { LinkedInError } from '../utils/LinkedInError.js';
import { RateLimiter, RateLimitExceededError } from '../../automation/utils/rateLimiter.js';

// Domain operations
import * as profileOps from './linkedinProfileOps.js';
import * as messagingOps from './linkedinMessagingOps.js';
import * as connectionOps from './linkedinConnectionOps.js';
import * as postOps from './linkedinPostOps.js';

const RandomHelpers = {
  async randomDelay(minMs = 300, maxMs = 800) {
    const span = Math.max(0, maxMs - minMs);
    const delayMs = minMs + Math.floor(Math.random() * (span + 1));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  },
};

/**
 * LinkedIn Interaction Service - Thin facade that delegates to domain operation files.
 *
 * Supports dependency injection for testing via constructor options.
 * All dependencies default to production implementations when not provided.
 */
export class LinkedInInteractionService {
  constructor(options = {}) {
    // Inject core dependencies or use defaults
    this.sessionManager = options.sessionManager || BrowserSessionManager;
    this.configManager = options.configManager || ConfigManager;
    this.dynamoDBService = options.dynamoDBService || new DynamoDBService();
    this.controlPlaneService = options.controlPlaneService || null;

    this.humanBehavior = options.humanBehavior || {
      async checkAndApplyCooldown() {},
      async simulateHumanMouseMovement() {},
      recordAction() {},
    };

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

    const errorConfig = this.configManager.getErrorHandlingConfig();
    this.maxRetries = errorConfig.retryAttempts;
    this.baseRetryDelay = errorConfig.retryBaseDelay;
    this._rateLimiter = new RateLimiter();

    logger.debug('LinkedInInteractionService initialized as facade', {
      maxRetries: this.maxRetries,
      baseRetryDelay: this.baseRetryDelay,
      injectedDependencies: Object.keys(options).length > 0,
      domainServices: ['navigation', 'messaging', 'connection'],
    });
  }

  // --- Shared utilities (used across domain files via service instance) ---

  async _paced(minMs, maxMs, fn) {
    await RandomHelpers.randomDelay(minMs, maxMs);
    return await fn();
  }

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

  async _applyControlPlaneRateLimits(_operation) {
    if (!this.controlPlaneService?.isConfigured) return;
    try {
      const cpLimits = await this.controlPlaneService.syncRateLimits();
      if (cpLimits?.linkedin_interactions) {
        const cp = cpLimits.linkedin_interactions;
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

  _reportInteraction(operation) {
    if (!this.controlPlaneService?.isConfigured) return;
    try {
      this.controlPlaneService.reportInteraction(operation);
    } catch {
      // Never block on telemetry failures
    }
  }

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

  async delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

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

  async waitForAnySelector(selectors, waitTimeout = 5000) {
    return await this.findElementBySelectors(selectors, waitTimeout);
  }

  async clickElementHumanly(page, element) {
    await element.click();
  }

  async clearAndTypeText(page, element, text) {
    await element.click();
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Delete');
    await this.typeWithHumanPattern(text, element);
  }

  // --- Profile operations ---

  async initializeBrowserSession() {
    return profileOps.initializeBrowserSession(this);
  }

  async getBrowserSession() {
    return profileOps.getBrowserSession(this);
  }

  async closeBrowserSession() {
    return profileOps.closeBrowserSession(this);
  }

  async isSessionActive() {
    return profileOps.isSessionActive(this);
  }

  async getSessionStatus() {
    return profileOps.getSessionStatus(this);
  }

  async checkSuspiciousActivity() {
    return profileOps.checkSuspiciousActivity(this);
  }

  async navigateToProfile(profileId) {
    return profileOps.navigateToProfile(this, profileId);
  }

  async verifyProfilePage(page) {
    return profileOps.verifyProfilePage(this, page);
  }

  async waitForLinkedInLoad() {
    return profileOps.waitForLinkedInLoad(this);
  }

  async waitForPageStability(maxWaitMs, sampleIntervalMs) {
    return profileOps.waitForPageStability(this, maxWaitMs, sampleIntervalMs);
  }

  async handleBrowserRecovery(error, context) {
    return profileOps.handleBrowserRecovery(this, error, context);
  }

  // --- Messaging operations ---

  async sendMessage(recipientProfileId, messageContent, userId) {
    return messagingOps.sendMessage(this, recipientProfileId, messageContent, userId);
  }

  async _scrapeAndStoreConversation(profileId) {
    return messagingOps._scrapeAndStoreConversation(this, profileId);
  }

  async navigateToMessaging(profileId) {
    return messagingOps.navigateToMessaging(this, profileId);
  }

  async waitForMessagingInterface() {
    return messagingOps.waitForMessagingInterface(this);
  }

  async composeAndSendMessage(messageContent) {
    return messagingOps.composeAndSendMessage(this, messageContent);
  }

  async waitForMessageSent() {
    return messagingOps.waitForMessageSent(this);
  }

  async typeWithHumanPattern(text, element = null) {
    return messagingOps.typeWithHumanPattern(this, text, element);
  }

  async executeMessagingWorkflow(recipientProfileId, messageContent, options = {}) {
    return messagingOps.executeMessagingWorkflow(this, recipientProfileId, messageContent, options);
  }

  // --- Connection operations ---

  async sendConnectionRequest(profileId, jwtToken) {
    return connectionOps.sendConnectionRequest(this, profileId, jwtToken);
  }

  async checkConnectionStatus() {
    return connectionOps.checkConnectionStatus(this);
  }

  async isProfileContainer(buttonName) {
    return connectionOps.isProfileContainer(this, buttonName);
  }

  async ensureEdge(profileId, status, jwtToken) {
    return connectionOps.ensureEdge(this, profileId, status, jwtToken);
  }

  async getEarlyConnectionStatus() {
    return connectionOps.getEarlyConnectionStatus(this);
  }

  createConnectionWorkflowResult(profileId, connectionMessage, workflowData) {
    return connectionOps.createConnectionWorkflowResult(profileId, connectionMessage, workflowData);
  }

  async executeConnectionWorkflow(profileId, connectionMessage = '', options = {}) {
    return connectionOps.executeConnectionWorkflow(this, profileId, connectionMessage, options);
  }

  async followProfile(profileId, options = {}) {
    return connectionOps.followProfile(this, profileId, options);
  }

  async checkFollowStatus() {
    return connectionOps.checkFollowStatus(this);
  }

  async clickFollowButton(profileId) {
    return connectionOps.clickFollowButton(this, profileId);
  }

  // --- Post operations ---

  async createPost(content, mediaAttachments = [], userId) {
    return postOps.createPost(this, content, mediaAttachments, userId);
  }

  async navigateToPostCreator() {
    return postOps.navigateToPostCreator(this);
  }

  async waitForPostCreationInterface() {
    return postOps.waitForPostCreationInterface(this);
  }

  async composePost(content) {
    return postOps.composePost(this, content);
  }

  async addMediaAttachments(mediaAttachments) {
    return postOps.addMediaAttachments(this, mediaAttachments);
  }

  async inputPostContent(content) {
    return postOps.inputPostContent(this, content);
  }

  async attachMediaToPost(mediaAttachments) {
    return postOps.attachMediaToPost(this, mediaAttachments);
  }

  async publishPost() {
    return postOps.publishPost(this);
  }

  async createAndPublishPost(content, mediaAttachments = []) {
    return postOps.createAndPublishPost(this, content, mediaAttachments);
  }

  async executePostCreationWorkflow(content, mediaAttachments = [], options = {}) {
    return postOps.executePostCreationWorkflow(this, content, mediaAttachments, options);
  }

  // --- Validation ---

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
