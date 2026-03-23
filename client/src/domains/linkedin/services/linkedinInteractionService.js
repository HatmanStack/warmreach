import { logger } from '#utils/logger.js';
import { LinkedInNavigationService } from '../../navigation/services/linkedinNavigationService.js';
import { LinkedInMessagingService } from '../../messaging/services/linkedinMessagingService.js';
import { LinkedInConnectionService } from '../../connections/services/linkedinConnectionService.js';
import { LinkedInMessageScraperService } from '../../messaging/services/linkedinMessageScraperService.js';
import { RateLimiter } from '../../automation/utils/rateLimiter.js';
import { BaseLinkedInService } from './BaseLinkedInService.js';
import { InteractionNavigationService } from './interactionNavigationService.js';
import { InteractionMessagingService } from './interactionMessagingService.js';
import { InteractionConnectionService } from './interactionConnectionService.js';
import { InteractionPostService } from './interactionPostService.js';
import { InteractionFollowService } from './interactionFollowService.js';

/**
 * LinkedIn Interaction Service - Thin facade that delegates to domain sub-services.
 *
 * Supports dependency injection for testing via constructor options.
 * All dependencies default to production implementations when not provided.
 */
export class LinkedInInteractionService extends BaseLinkedInService {
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
    // Share a single RateLimiter across the facade and all sub-services
    const sharedRateLimiter = options.rateLimiter || new RateLimiter();
    super({ ...options, rateLimiter: sharedRateLimiter });

    // Initialize lower-level domain services (same as before)
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

    // Initialize interaction sub-services — share the single RateLimiter
    const subServiceOptions = { ...options, rateLimiter: sharedRateLimiter };

    this._interactionNavigationService = new InteractionNavigationService(subServiceOptions);
    this._interactionMessagingService = new InteractionMessagingService({
      ...subServiceOptions,
      interactionNavigationService: this._interactionNavigationService,
      messagingService: this.messagingService,
      messageScraperService: this.messageScraperService,
    });
    this._interactionConnectionService = new InteractionConnectionService({
      ...subServiceOptions,
      interactionNavigationService: this._interactionNavigationService,
      connectionService: this.connectionService,
    });
    this._interactionPostService = new InteractionPostService(subServiceOptions);
    this._interactionFollowService = new InteractionFollowService({
      ...subServiceOptions,
      interactionNavigationService: this._interactionNavigationService,
      interactionConnectionService: this._interactionConnectionService,
    });

    logger.debug('LinkedInInteractionService initialized as facade', {
      maxRetries: this.maxRetries,
      baseRetryDelay: this.baseRetryDelay,
      injectedDependencies: Object.keys(options).length > 0,
      domainServices: ['navigation', 'messaging', 'connection'],
    });
  }

  // ── Navigation ──────────────────────────────────────────────────────
  async navigateToProfile(profileId) {
    return this._interactionNavigationService.navigateToProfile(profileId);
  }

  async verifyProfilePage(page) {
    return this._interactionNavigationService.verifyProfilePage(page);
  }

  // ── Messaging ───────────────────────────────────────────────────────
  async sendMessage(recipientProfileId, messageContent, userId) {
    return this._interactionMessagingService.sendMessage(
      recipientProfileId,
      messageContent,
      userId
    );
  }

  async navigateToMessaging(profileId) {
    return this._interactionMessagingService.navigateToMessaging(profileId);
  }

  async waitForMessagingInterface() {
    return this._interactionMessagingService.waitForMessagingInterface();
  }

  async composeAndSendMessage(messageContent) {
    return this._interactionMessagingService.composeAndSendMessage(messageContent);
  }

  async waitForMessageSent() {
    return this._interactionMessagingService.waitForMessageSent();
  }

  async executeMessagingWorkflow(recipientProfileId, messageContent, options = {}) {
    return this._interactionMessagingService.executeMessagingWorkflow(
      recipientProfileId,
      messageContent,
      options
    );
  }

  // ── Connections ─────────────────────────────────────────────────────
  async sendConnectionRequest(profileId, jwtToken) {
    return this._interactionConnectionService.sendConnectionRequest(profileId, jwtToken);
  }

  async checkConnectionStatus() {
    return this._interactionConnectionService.checkConnectionStatus();
  }

  async isProfileContainer(buttonName) {
    return this._interactionConnectionService.isProfileContainer(buttonName);
  }

  async ensureEdge(profileId, status, jwtToken) {
    return this._interactionConnectionService.ensureEdge(profileId, status, jwtToken);
  }

  async getEarlyConnectionStatus() {
    return this._interactionConnectionService.getEarlyConnectionStatus();
  }

  createConnectionWorkflowResult(profileId, connectionMessage, workflowData) {
    return this._interactionConnectionService.createConnectionWorkflowResult(
      profileId,
      connectionMessage,
      workflowData
    );
  }

  async executeConnectionWorkflow(profileId, connectionMessage = '', options = {}) {
    return this._interactionConnectionService.executeConnectionWorkflow(
      profileId,
      connectionMessage,
      options
    );
  }

  // ── Posts ────────────────────────────────────────────────────────────
  async createPost(content, mediaAttachments = [], userId) {
    return this._interactionPostService.createPost(content, mediaAttachments, userId);
  }

  async navigateToPostCreator() {
    return this._interactionPostService.navigateToPostCreator();
  }

  async waitForPostCreationInterface() {
    return this._interactionPostService.waitForPostCreationInterface();
  }

  async composePost(content) {
    return this._interactionPostService.composePost(content);
  }

  async addMediaAttachments(mediaAttachments) {
    return this._interactionPostService.addMediaAttachments(mediaAttachments);
  }

  async inputPostContent(content) {
    return this._interactionPostService.inputPostContent(content);
  }

  async attachMediaToPost(mediaAttachments) {
    return this._interactionPostService.attachMediaToPost(mediaAttachments);
  }

  async publishPost() {
    return this._interactionPostService.publishPost();
  }

  async createAndPublishPost(content, mediaAttachments = []) {
    return this._interactionPostService.createAndPublishPost(content, mediaAttachments);
  }

  async executePostCreationWorkflow(content, mediaAttachments = [], options = {}) {
    return this._interactionPostService.executePostCreationWorkflow(
      content,
      mediaAttachments,
      options
    );
  }

  // ── Follow ──────────────────────────────────────────────────────────
  async followProfile(profileId, options = {}) {
    return this._interactionFollowService.followProfile(profileId, options);
  }

  async checkFollowStatus() {
    return this._interactionFollowService.checkFollowStatus();
  }

  async clickFollowButton(profileId) {
    return this._interactionFollowService.clickFollowButton(profileId);
  }
}
