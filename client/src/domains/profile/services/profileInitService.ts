import { logger } from '#utils/logger.js';
import { ProfileInitStateManager } from '../utils/profileInitStateManager.js';
import { LinkedInErrorHandler } from '../../linkedin/utils/linkedinErrorHandler.js';
import { generateProfileMarkdown } from '../utils/profileMarkdownGenerator.js';
import axios from 'axios';
import fs from 'fs/promises';
import type { PuppeteerService } from '../../automation/services/puppeteerService.js';
import type { LinkedInService } from '../../linkedin/services/linkedinService.js';
import { LinkedInMessageScraperService } from '../../messaging/services/linkedinMessageScraperService.js';
import { BrowserSessionManager } from '../../session/services/browserSessionManager.js';
import { RagstackProxyService } from '../../ragstack/services/ragstackProxyService.js';
import { BatchProcessor } from './batchProcessor.js';
import { IngestionPipeline } from './ingestionPipeline.js';
import type { ProcessingResult } from './batchProcessor.js';

/**
 * Profile initialization state
 */
interface ProfileInitState {
  requestId?: string;
  recursionCount?: number;
  healPhase?: string;
  currentProcessingList?: string;
  currentBatch?: number;
  currentIndex?: number;
  jwtToken?: string;
  searchName?: string;
  searchPassword?: string;
  credentialsCiphertext?: string;
  masterIndexFile?: string;
  totalConnections?: {
    ally: number;
    incoming: number;
    outgoing: number;
  };
  completedBatches?: number[];
  lastError?: {
    connectionType: string;
    message: string;
    timestamp: string;
  };
  listCreationState?: {
    connectionType: string;
    expansionAttempt: number;
    currentFileIndex: number;
  };
}

/**
 * Initialization result
 */
export interface InitializationResult {
  success: boolean;
  message: string;
  data: ProcessingResult;
  metadata: {
    requestId: string;
    duration: number;
    timestamp: string;
  };
}

/**
 * Error details from categorization
 */
interface ErrorDetails {
  type?: string;
  category: string;
  severity?: string;
  isRecoverable?: boolean;
  retryable?: boolean;
  maxRetries?: number;
  skipConnection?: boolean;
  httpStatus?: number;
  message?: string;
  suggestions?: string[];
}

/**
 * DynamoDB service interface
 */
interface DynamoDBService {
  setAuthToken(token: string): void;
  checkEdgeExists(profileId: string): Promise<boolean>;
  upsertEdgeStatus(
    profileId: string,
    status: string,
    extraUpdates?: Record<string, unknown>
  ): Promise<unknown>;
  updateMessages(profileId: string, messages: unknown[]): Promise<unknown>;
  getProfileDetails(profileId: string): Promise<unknown>;
  markBadContact(profileId: string): Promise<void>;
  createProfileMetadata?(profileId: string, metadata: Record<string, string>): Promise<unknown>;
  canScrapeToday?(): Promise<boolean>;
  incrementDailyScrapeCount?(): Promise<unknown>;
  saveImportCheckpoint?(checkpoint: Record<string, unknown>): Promise<unknown>;
  getImportCheckpoint?(): Promise<Record<string, unknown> | null>;
  clearImportCheckpoint?(): Promise<unknown>;
}

/**
 * Local profile scraper interface
 */
interface LocalProfileScraperInterface {
  scrapeProfile(profileId: string): Promise<{
    name: string | null;
    headline: string | null;
    location: string | null;
    about: string | null;
    currentPosition: { title: string; company: string } | null;
    experience: unknown[];
    education: unknown[];
    skills: string[];
    recentActivity: unknown[];
  }>;
}

/**
 * Burst throttle manager interface
 */
interface BurstThrottleManagerInterface {
  waitForNext(): Promise<{ delayed: boolean; delayMs: number }>;
  reset(): void;
}

/**
 * Import mode interface for queue/backoff
 */
interface ImportModeToggle {
  setImportMode(enabled: boolean): void;
}

/**
 * Gets the API base URL from environment, with proper normalization
 */
function getApiBaseUrl(): string | undefined {
  const baseUrl = process.env.API_GATEWAY_BASE_URL;
  if (!baseUrl) return undefined;
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

/**
 * Profile initialization service.
 * Thin orchestrator that delegates batch processing to BatchProcessor
 * and RAGStack ingestion to IngestionPipeline.
 */
export class ProfileInitService {
  private linkedInService: LinkedInService;
  private dynamoDBService: DynamoDBService;
  private messageScraperService: InstanceType<typeof LinkedInMessageScraperService>;
  private ragstackProxy: RagstackProxyService;
  private batchProcessor: BatchProcessor;
  private ingestionPipeline: IngestionPipeline;

  constructor(
    puppeteerService: PuppeteerService,
    linkedInService: LinkedInService,
    _linkedInContactService: unknown,
    dynamoDBService: DynamoDBService,
    localProfileScraper?: LocalProfileScraperInterface,
    burstThrottleManager?: BurstThrottleManagerInterface,
    interactionQueue?: ImportModeToggle,
    backoffController?: ImportModeToggle
  ) {
    this.linkedInService = linkedInService;
    this.dynamoDBService = dynamoDBService;
    this.messageScraperService = new LinkedInMessageScraperService({
      sessionManager: BrowserSessionManager,
    });
    this.ragstackProxy = new RagstackProxyService({
      apiBaseUrl: getApiBaseUrl(),
      httpClient: axios,
    });

    // Initialize extracted classes
    this.ingestionPipeline = new IngestionPipeline({
      ragstackProxy: this.ragstackProxy,
      generateProfileMarkdown,
    });

    this.batchProcessor = new BatchProcessor({
      dynamoDBService,
      linkedInService,
      localProfileScraper: localProfileScraper || null,
      burstThrottleManager: burstThrottleManager || null,
      interactionQueue: interactionQueue || null,
      backoffController: backoffController || null,
      ragstackProxy: this.ragstackProxy,
      puppeteer: puppeteerService,
      ingestionPipeline: this.ingestionPipeline,
      batchSize: 100,
    });
  }

  /**
   * Initialize user profile database with LinkedIn data
   */
  async initializeUserProfile(state: ProfileInitState): Promise<InitializationResult> {
    const requestId = state.requestId || 'unknown';
    const startTime = Date.now();

    try {
      logger.info('Starting profile initialization process', {
        requestId,
        recursionCount: state.recursionCount || 0,
        healPhase: state.healPhase,
        isResuming: ProfileInitStateManager.isResumingState(state),
        currentProcessingList: state.currentProcessingList,
        currentBatch: state.currentBatch,
        currentIndex: state.currentIndex,
      });

      // Set auth token for DynamoDB and scrape operations
      if (state.jwtToken) {
        this.dynamoDBService.setAuthToken(state.jwtToken);
      }

      // Perform LinkedIn login using existing LinkedInService
      await this.linkedInService.login(
        state.searchName,
        state.searchPassword,
        (state.recursionCount || 0) > 0,
        state.credentialsCiphertext,
        'profile-init'
      );

      // Process connection lists in batches (delegates to BatchProcessor)
      const result = await this.processConnectionLists(state);

      const totalDuration = Date.now() - startTime;
      logger.info('Profile initialization completed successfully', {
        requestId,
        totalDuration,
        processed: result.processed,
        skipped: result.skipped,
        errors: result.errors,
        progressSummary: result.progressSummary,
      });

      return {
        success: true,
        message: 'Profile database initialized successfully',
        data: result,
        metadata: {
          requestId,
          duration: totalDuration,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (err) {
      const error = err as Error & { context?: Record<string, unknown> };
      const totalDuration = Date.now() - startTime;
      const errorDetails = LinkedInErrorHandler.categorizeError(error) as ErrorDetails;

      logger.error('Profile initialization failed', {
        requestId,
        totalDuration,
        errorType: errorDetails.type,
        errorCategory: errorDetails.category,
        message: error.message,
        stack: error.stack,
        isRecoverable: errorDetails.isRecoverable,
        currentState: {
          processingList: state.currentProcessingList,
          batch: state.currentBatch,
          index: state.currentIndex,
          recursionCount: state.recursionCount,
        },
      });

      // Add context to error for better debugging
      error.context = {
        requestId,
        duration: totalDuration,
        state: {
          processingList: state.currentProcessingList,
          batch: state.currentBatch,
          index: state.currentIndex,
          recursionCount: state.recursionCount,
        },
        errorDetails,
      };

      throw error;
    }
  }

  /**
   * Process connection lists with batch processing.
   * Delegates to BatchProcessor, then runs message scraping phase.
   */
  async processConnectionLists(state: ProfileInitState): Promise<ProcessingResult> {
    const result = await this.batchProcessor.processConnectionLists(state);

    // Phase 2: Scrape message histories and update edges
    if (state.masterIndexFile) {
      await this._scrapeAndStoreMessages(state.masterIndexFile);
    }

    return result;
  }

  /**
   * Trigger RAGStack ingestion for a profile.
   * Delegates to IngestionPipeline.
   */
  async triggerRAGStackIngestion(profileId: string, state: ProfileInitState): Promise<unknown> {
    return this.ingestionPipeline.triggerRAGStackIngestion(profileId, state);
  }

  /**
   * Scrape LinkedIn message histories and store them on edges.
   * Runs after edge creation so failures don't block profile init.
   */
  private async _scrapeAndStoreMessages(masterIndexFile: string): Promise<void> {
    try {
      logger.info('Starting message history scraping phase');

      // Load master index to get batch file references
      const content = await fs.readFile(masterIndexFile, 'utf8');
      const masterIndex = JSON.parse(content);
      const allConnectionIds: string[] = [];

      for (const connectionType of ['ally', 'outgoing', 'incoming'] as const) {
        const links = await this.batchProcessor._loadExistingLinksFromFiles(
          connectionType,
          masterIndex
        );
        for (const link of links) {
          const match = link.match(/\/in\/([^/?\s]+)/);
          const profileId = match?.[1]?.replace(/\/$/, '') ?? link;
          if (profileId && profileId !== 'undefined') {
            allConnectionIds.push(profileId);
          }
        }
      }

      if (allConnectionIds.length === 0) {
        logger.info('No connection IDs found for message scraping');
        return;
      }

      logger.info(`Scraping message histories for ${allConnectionIds.length} connections`);

      const scrapedMessages =
        await this.messageScraperService.scrapeAllConversations(allConnectionIds);

      if (scrapedMessages.size === 0) {
        logger.info('No message histories scraped');
        return;
      }

      // Store scraped messages on edges
      let stored = 0;
      for (const [profileId, messages] of scrapedMessages) {
        try {
          await this.dynamoDBService.updateMessages(profileId, messages);
          stored++;
        } catch (error) {
          logger.warn(`Failed to store messages for ${profileId}: ${(error as Error).message}`);
        }
      }

      logger.info(`Message scraping phase complete: ${stored}/${scrapedMessages.size} stored`);
    } catch (error) {
      // Message scraping failure should NOT block profile init
      logger.warn(`Message scraping phase failed (non-blocking): ${(error as Error).message}`);
    }
  }
}
