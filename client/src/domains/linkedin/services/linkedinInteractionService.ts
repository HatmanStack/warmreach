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
import type { Page, ElementHandle } from 'puppeteer';
import {
  asBrowserSessionManagerContract,
  asConfigManagerContract,
  unsafeAsOpsContext,
  type BrowserSessionManagerContract,
  type ConfigManagerContract,
  type ControlPlaneServiceContract,
  type HumanBehaviorContract,
} from '../types/ServiceContracts.js';

// Domain operations
import * as profileOps from './linkedinProfileOps.js';
import * as messagingOps from './linkedinMessagingOps.js';
import * as connectionOps from './linkedinConnectionOps.js';
import * as postOps from './linkedinPostOps.js';
import type { ProfileOpsContext } from './linkedinProfileOps.js';
import type { MessagingOpsContext } from './linkedinMessagingOps.js';
import type { ConnectionOpsContext } from './linkedinConnectionOps.js';
import type { PostOpsContext } from './linkedinPostOps.js';

type OpsContext = ProfileOpsContext & MessagingOpsContext & ConnectionOpsContext & PostOpsContext;

interface ServiceOptions {
  sessionManager?: BrowserSessionManagerContract;
  configManager?: ConfigManagerContract;
  dynamoDBService?: DynamoDBService;
  controlPlaneService?: ControlPlaneServiceContract | null;
  humanBehavior?: HumanBehaviorContract;
  navigationService?: LinkedInNavigationService;
  messagingService?: LinkedInMessagingService;
  connectionService?: LinkedInConnectionService;
  messageScraperService?: LinkedInMessageScraperService;
}

interface ExecutionContext {
  operation?: string;
  attemptCount?: number;
  [key: string]: unknown;
}

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

interface WorkflowParams {
  recipientProfileId?: string;
  messageContent?: string;
  profileId?: string;
  connectionMessage?: string;
  content?: string;
  mediaAttachments?: unknown[];
  operations?: unknown[];
}

const RandomHelpers = {
  async randomDelay(minMs = 300, maxMs = 800): Promise<void> {
    const span = Math.max(0, maxMs - minMs);
    const delayMs = minMs + Math.floor(Math.random() * (span + 1));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  },
};

/**
 * Each ops module defines its own narrow ServiceContext interface.
 * This service satisfies all of them at runtime via duck typing.
 * The _self() helper bridges the structural mismatch with a single cast
 * rather than repeating type assertions at every delegation call site.
 */

/**
 * LinkedIn Interaction Service - Thin facade that delegates to domain operation files.
 *
 * Supports dependency injection for testing via constructor options.
 * All dependencies default to production implementations when not provided.
 */
export class LinkedInInteractionService {
  // BrowserSessionManager is a static-method class used as a duck-typed singleton.
  // ConfigManager's default export is an instance from getInstance().
  // Both are adapted via named helper functions in ServiceContracts.ts.
  sessionManager: BrowserSessionManagerContract;
  configManager: ConfigManagerContract;
  dynamoDBService: DynamoDBService;
  controlPlaneService: ControlPlaneServiceContract | null;
  humanBehavior: HumanBehaviorContract;
  navigationService: LinkedInNavigationService;
  messagingService: LinkedInMessagingService;
  connectionService: LinkedInConnectionService;
  messageScraperService: LinkedInMessageScraperService;
  maxRetries: number;
  baseRetryDelay: number;
  _rateLimiter: RateLimiter;

  constructor(options: ServiceOptions = {}) {
    // Named adapters do the structural narrowing; see ServiceContracts.ts.
    this.sessionManager =
      options.sessionManager || asBrowserSessionManagerContract(BrowserSessionManager);
    this.configManager = options.configManager || asConfigManagerContract(ConfigManager);
    this.dynamoDBService = options.dynamoDBService || new DynamoDBService();
    this.controlPlaneService = options.controlPlaneService || null;

    this.humanBehavior = options.humanBehavior || {
      async checkAndApplyCooldown() {},
      async simulateHumanMouseMovement() {},
      recordAction() {},
    };

    // Each domain service accepts the narrow DI contract directly. Historically
    // these required structural casts because the upstream types were wider;
    // now we pass the contract values that ServiceContracts produced.
    type NavCtorArg = ConstructorParameters<typeof LinkedInNavigationService>[0];
    type MsgCtorArg = ConstructorParameters<typeof LinkedInMessagingService>[0];
    type ConnCtorArg = ConstructorParameters<typeof LinkedInConnectionService>[0];
    type ScrapeCtorArg = ConstructorParameters<typeof LinkedInMessageScraperService>[0];

    const sm: BrowserSessionManagerContract = this.sessionManager;
    const cm: ConfigManagerContract = this.configManager;
    const db: DynamoDBService = this.dynamoDBService;

    this.navigationService =
      options.navigationService ||
      new LinkedInNavigationService({ sessionManager: sm, configManager: cm } as NavCtorArg);

    this.messagingService =
      options.messagingService ||
      new LinkedInMessagingService(
        unsafeAsOpsContext<
          {
            sessionManager: BrowserSessionManagerContract;
            navigationService: LinkedInNavigationService;
            dynamoDBService: DynamoDBService;
          },
          MsgCtorArg
        >({
          sessionManager: sm,
          navigationService: this.navigationService,
          dynamoDBService: db,
        })
      );

    this.connectionService =
      options.connectionService ||
      new LinkedInConnectionService({
        sessionManager: sm,
        navigationService: this.navigationService,
        dynamoDBService: db,
      } as ConnCtorArg);

    this.messageScraperService =
      options.messageScraperService ||
      new LinkedInMessageScraperService({ sessionManager: sm } as ScrapeCtorArg);

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

  async _paced<T>(minMs: number, maxMs: number, fn: () => Promise<T>): Promise<T> {
    await RandomHelpers.randomDelay(minMs, maxMs);
    return await fn();
  }

  _enforceRateLimit(): void {
    try {
      this._rateLimiter.enforce();
    } catch (err: unknown) {
      if (err instanceof RateLimitExceededError) {
        throw new LinkedInError('Rate limit exceeded', 'LINKEDIN_RATE_LIMIT');
      }
      throw err;
    }
  }

  async _applyControlPlaneRateLimits(_operation: string): Promise<void> {
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
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.debug('Control plane rate limit sync skipped', { error: errMsg });
    }
  }

  _reportInteraction(operation: string): void {
    if (!this.controlPlaneService?.isConfigured) return;
    try {
      this.controlPlaneService.reportInteraction(operation);
    } catch {
      // Never block on telemetry failures
    }
  }

  async executeOnce<T>(operation: () => Promise<T>, context: ExecutionContext = {}): Promise<T> {
    try {
      context.attemptCount = 1;
      return await operation();
    } catch (error: unknown) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      const categorizedError = LinkedInErrorHandler.categorizeError(errorObj);
      logger.error(`Operation ${context.operation || 'unknown'} failed without retry`, {
        context,
        error: errorObj.message,
        errorCategory: categorizedError.category,
      });
      throw error;
    }
  }

  async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async findElementBySelectors(
    selectors: string[],
    waitTimeout = 3000
  ): Promise<{ element: ElementHandle | null; selector: string | null }> {
    const session = await this.getBrowserSession();
    for (const selector of selectors) {
      try {
        const element = await (
          session as {
            waitForSelector(s: string, opts: { timeout: number }): Promise<ElementHandle | null>;
          }
        ).waitForSelector(selector, { timeout: waitTimeout });
        if (element) {
          return { element, selector };
        }
      } catch {
        // try next selector
      }
    }
    return { element: null, selector: null };
  }

  async waitForAnySelector(
    selectors: string[],
    waitTimeout = 5000
  ): Promise<{ element: ElementHandle | null; selector: string | null }> {
    return await this.findElementBySelectors(selectors, waitTimeout);
  }

  async clickElementHumanly(_page: Page, element: ElementHandle): Promise<void> {
    await element.click();
  }

  async clearAndTypeText(page: Page, element: ElementHandle, text: string): Promise<void> {
    await element.click();
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Delete');
    await this.typeWithHumanPattern(text, element);
  }

  /**
   * Return ``this`` typed as the merged ops context. Each ops module defines
   * its own narrow ``ServiceContext`` interface; see ``unsafeAsOpsContext`` in
   * ServiceContracts for the named adapter that handles the legacy return-type
   * mismatches (e.g. some ops declare ``Promise<void>`` where the facade
   * returns ``Promise<boolean>``). The adapter keeps the unsafe step scoped
   * and documented instead of sprinkled inline.
   */
  private get _self(): OpsContext {
    return unsafeAsOpsContext(this);
  }

  // --- Profile operations ---

  async initializeBrowserSession() {
    return profileOps.initializeBrowserSession(this._self);
  }

  async getBrowserSession() {
    return profileOps.getBrowserSession(this._self);
  }

  async closeBrowserSession() {
    return profileOps.closeBrowserSession(this._self);
  }

  async isSessionActive() {
    return profileOps.isSessionActive(this._self);
  }

  async getSessionStatus() {
    return profileOps.getSessionStatus(this._self);
  }

  async checkSuspiciousActivity() {
    return profileOps.checkSuspiciousActivity(this._self);
  }

  async navigateToProfile(profileId: string): Promise<boolean> {
    return profileOps.navigateToProfile(this._self, profileId);
  }

  async verifyProfilePage(page: Page): Promise<boolean> {
    return profileOps.verifyProfilePage(this._self, page);
  }

  async waitForLinkedInLoad(): Promise<boolean | void> {
    return profileOps.waitForLinkedInLoad(this._self);
  }

  async waitForPageStability(maxWaitMs?: number, sampleIntervalMs?: number): Promise<boolean> {
    return profileOps.waitForPageStability(this._self, maxWaitMs, sampleIntervalMs);
  }

  async handleBrowserRecovery(error: Error, context: Record<string, unknown>): Promise<void> {
    return profileOps.handleBrowserRecovery(this._self, error, context);
  }

  // --- Messaging operations ---

  async sendMessage(recipientProfileId: string, messageContent: string, userId: string) {
    return messagingOps.sendMessage(this._self, recipientProfileId, messageContent, userId);
  }

  async _scrapeAndStoreConversation(profileId: string): Promise<void> {
    return messagingOps._scrapeAndStoreConversation(this._self, profileId);
  }

  async navigateToMessaging(profileId: string): Promise<void> {
    return messagingOps.navigateToMessaging(this._self, profileId);
  }

  async waitForMessagingInterface(): Promise<void> {
    return messagingOps.waitForMessagingInterface(this._self);
  }

  async composeAndSendMessage(messageContent: string) {
    return messagingOps.composeAndSendMessage(this._self, messageContent);
  }

  async waitForMessageSent(): Promise<void> {
    return messagingOps.waitForMessageSent(this._self);
  }

  async typeWithHumanPattern(text: string, element: ElementHandle | null = null): Promise<void> {
    return messagingOps.typeWithHumanPattern(this._self, text, element);
  }

  async executeMessagingWorkflow(
    recipientProfileId: string,
    messageContent: string,
    options: Record<string, unknown> = {}
  ) {
    return messagingOps.executeMessagingWorkflow(
      this._self,
      recipientProfileId,
      messageContent,
      options
    );
  }

  // --- Connection operations ---

  async sendConnectionRequest(profileId: string, jwtToken?: string) {
    return connectionOps.sendConnectionRequest(this._self, profileId, jwtToken);
  }

  async checkConnectionStatus(): Promise<string> {
    return connectionOps.checkConnectionStatus(this._self);
  }

  async isProfileContainer(buttonName: string): Promise<boolean> {
    return connectionOps.isProfileContainer(this._self, buttonName);
  }

  async ensureEdge(profileId: string, status: string, jwtToken?: string): Promise<void> {
    return connectionOps.ensureEdge(this._self, profileId, status, jwtToken);
  }

  async getEarlyConnectionStatus(): Promise<string | null> {
    return connectionOps.getEarlyConnectionStatus(this._self);
  }

  createConnectionWorkflowResult(
    profileId: string,
    connectionMessage: string,
    workflowData: Parameters<typeof connectionOps.createConnectionWorkflowResult>[2]
  ) {
    return connectionOps.createConnectionWorkflowResult(profileId, connectionMessage, workflowData);
  }

  async executeConnectionWorkflow(
    profileId: string,
    connectionMessage = '',
    options: Record<string, unknown> = {}
  ) {
    return connectionOps.executeConnectionWorkflow(
      this._self,
      profileId,
      connectionMessage,
      options
    );
  }

  async followProfile(profileId: string, options: Record<string, unknown> = {}) {
    return connectionOps.followProfile(this._self, profileId, options);
  }

  async checkFollowStatus(): Promise<boolean> {
    return connectionOps.checkFollowStatus(this._self);
  }

  async clickFollowButton(profileId: string) {
    return connectionOps.clickFollowButton(this._self, profileId);
  }

  // --- Post operations ---

  async createPost(content: string, mediaAttachments: unknown[] = [], userId: string) {
    return postOps.createPost(
      this._self,
      content,
      mediaAttachments as Parameters<typeof postOps.createPost>[2],
      userId
    );
  }

  async navigateToPostCreator(): Promise<void> {
    return postOps.navigateToPostCreator(this._self);
  }

  async waitForPostCreationInterface(): Promise<void> {
    return postOps.waitForPostCreationInterface(this._self);
  }

  async composePost(content: string): Promise<void> {
    return postOps.composePost(this._self, content);
  }

  async addMediaAttachments(mediaAttachments: unknown[]): Promise<void> {
    return postOps.addMediaAttachments(
      this._self,
      mediaAttachments as Parameters<typeof postOps.addMediaAttachments>[1]
    );
  }

  async inputPostContent(content: string): Promise<void> {
    return postOps.inputPostContent(this._self, content);
  }

  async attachMediaToPost(mediaAttachments: unknown[]): Promise<void> {
    return postOps.attachMediaToPost(
      this._self,
      mediaAttachments as Parameters<typeof postOps.attachMediaToPost>[1]
    );
  }

  async publishPost() {
    return postOps.publishPost(this._self);
  }

  async createAndPublishPost(content: string, mediaAttachments: unknown[] = []) {
    return postOps.createAndPublishPost(
      this._self,
      content,
      mediaAttachments as Parameters<typeof postOps.createAndPublishPost>[2]
    );
  }

  async executePostCreationWorkflow(
    content: string,
    mediaAttachments: unknown[] = [],
    options: Record<string, unknown> = {}
  ) {
    return postOps.executePostCreationWorkflow(
      this._self,
      content,
      mediaAttachments as Parameters<typeof postOps.executePostCreationWorkflow>[2],
      options
    );
  }

  // --- Validation ---

  validateWorkflowParameters(workflowType: string, params: WorkflowParams): ValidationResult {
    const validation: ValidationResult = {
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
