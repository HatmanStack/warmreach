import { logger } from '#utils/logger.js';
import { ProfileInitStateManager } from '../utils/profileInitStateManager.js';
import { LinkedInErrorHandler } from '../../linkedin/utils/linkedinErrorHandler.js';
import axios from 'axios';
import type { PuppeteerService } from '../../automation/services/puppeteerService.js';
import type { LinkedInService, ConnectionType } from '../../linkedin/services/linkedinService.js';
import { LinkedInMessageScraperService } from '../../messaging/services/linkedinMessageScraperService.js';
import { BrowserSessionManager } from '../../session/services/browserSessionManager.js';
import { RagstackProxyService } from '../../ragstack/services/ragstackProxyService.js';

// Domain operations
import { scrapeAndStoreMessages } from './profileScraping.js';
import { processConnectionType } from './profileBatchProcessing.js';
import {
  triggerRAGStackIngestion as _triggerRAGStackIngestion,
  createMasterIndexFile as _createMasterIndexFile,
  loadMasterIndex as _loadMasterIndex,
  updateMasterIndex as _updateMasterIndex,
} from './profileIngestion.js';

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
  [key: string]: unknown;
}

/**
 * Master index file structure
 */
export interface MasterIndex {
  metadata: {
    capturedAt: string;
    totalAllies: number;
    totalIncoming: number;
    totalOutgoing: number;
    batchSize: number;
    [key: string]: unknown;
  };
  files: {
    allyConnections: FileReference[];
    incomingConnections: FileReference[];
    outgoingConnections: FileReference[];
    [key: string]: FileReference[];
  };
  processingState: {
    currentList: string;
    currentBatch: number;
    currentIndex: number;
    completedBatches: number[];
  };
}

/**
 * File reference in master index
 */
interface FileReference {
  fileName: string;
  filePath?: string;
  fileIndex?: number;
  totalLinks?: number;
  capturedAt?: string;
  isComplete?: boolean;
}

/**
 * Processing result
 */
interface ProcessingResult {
  processed: number;
  skipped: number;
  errors: number;
  connectionTypes?: Record<string, TypeResult>;
  progressSummary?: unknown;
  batches?: BatchResult[];
}

/**
 * Type-specific processing result
 */
interface TypeResult {
  processed: number;
  skipped: number;
  errors: number;
  batches: BatchResult[];
}

/**
 * Batch processing result
 */
interface BatchResult {
  batchNumber: number;
  batchFilePath?: string;
  processed: number;
  skipped: number;
  errors: number;
  connections: ConnectionProcessResult[];
  startTime?: string;
  endTime?: string;
  duration?: number;
}

/**
 * Individual connection processing result
 */
interface ConnectionProcessResult {
  profileId: string;
  action?: string;
  status?: string;
  reason?: string;
  error?: string;
  errorType?: string;
  errorCategory?: string;
  index: number;
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
 * Thin orchestrator that coordinates profile database initialization.
 * Delegates connection processing, batch handling, and ingestion to sibling files.
 */
export class ProfileInitService {
  readonly puppeteer: PuppeteerService;
  readonly linkedInService: LinkedInService;
  readonly dynamoDBService: DynamoDBService;
  readonly messageScraperService: InstanceType<typeof LinkedInMessageScraperService>;
  readonly localProfileScraper: LocalProfileScraperInterface | null;
  readonly burstThrottleManager: BurstThrottleManagerInterface | null;
  readonly interactionQueue: ImportModeToggle | null;
  readonly backoffController: ImportModeToggle | null;
  readonly ragstackProxy: RagstackProxyService;
  readonly batchSize: number;

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
    this.puppeteer = puppeteerService;
    this.linkedInService = linkedInService;
    this.dynamoDBService = dynamoDBService;
    this.localProfileScraper = localProfileScraper || null;
    this.burstThrottleManager = burstThrottleManager || null;
    this.interactionQueue = interactionQueue || null;
    this.backoffController = backoffController || null;
    this.messageScraperService = new LinkedInMessageScraperService({
      sessionManager: BrowserSessionManager,
    });
    this.ragstackProxy = new RagstackProxyService({
      apiBaseUrl: getApiBaseUrl(),
      httpClient: axios,
    });
    this.batchSize = 100;
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

      if (state.jwtToken) {
        this.dynamoDBService.setAuthToken(state.jwtToken);
      }

      await this.linkedInService.login(
        state.searchName,
        state.searchPassword,
        (state.recursionCount || 0) > 0,
        state.credentialsCiphertext,
        'profile-init'
      );

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
   * Process connection lists with batch processing
   */
  async processConnectionLists(state: ProfileInitState): Promise<ProcessingResult> {
    this.interactionQueue?.setImportMode(true);
    this.backoffController?.setImportMode(true);

    try {
      logger.info('Starting connection list processing');

      ProfileInitStateManager.validateState(state);

      const checkpoint = await this.dynamoDBService.getImportCheckpoint?.();
      if (checkpoint) {
        logger.info('Resuming from import checkpoint', {
          connectionType: checkpoint.connectionType,
          batchIndex: checkpoint.batchIndex,
          lastProfileId: checkpoint.lastProfileId,
        });
        state.currentProcessingList = checkpoint.connectionType as string;
        state.currentBatch = checkpoint.batchIndex as number;
      }

      let masterIndexFile = state.masterIndexFile;
      if (!masterIndexFile) {
        masterIndexFile = await this._createMasterIndexFile();
        state.masterIndexFile = masterIndexFile;
      }

      const masterIndex = await this._loadMasterIndex(masterIndexFile);

      if (masterIndex.metadata) {
        state.totalConnections = {
          ally: masterIndex.metadata.totalAllies || 0,
          incoming: masterIndex.metadata.totalIncoming || 0,
          outgoing: masterIndex.metadata.totalOutgoing || 0,
        };
      }

      const connectionTypes: ConnectionType[] = ['ally', 'outgoing', 'incoming'];
      const results: ProcessingResult = {
        processed: 0,
        skipped: 0,
        errors: 0,
        connectionTypes: {},
        progressSummary: ProfileInitStateManager.getProgressSummary(state),
      };

      const processedInThisRun = new Set<string>();

      for (const connectionType of connectionTypes) {
        if (processedInThisRun.has(connectionType)) {
          logger.info(`Skipping ${connectionType} connections - already processed in this run`);
          continue;
        }

        if (state.currentProcessingList && state.currentProcessingList !== connectionType) {
          logger.info(
            `Skipping ${connectionType} connections - resuming from ${state.currentProcessingList}`
          );
          continue;
        }

        logger.info(`Processing ${connectionType} connections`);
        processedInThisRun.add(connectionType);

        try {
          const typeResult = await processConnectionType(this, connectionType, masterIndex, state);

          results.connectionTypes![connectionType] = typeResult;
          results.processed += typeResult.processed;
          results.skipped += typeResult.skipped;
          results.errors += typeResult.errors;

          state = ProfileInitStateManager.updateBatchProgress(state, {
            currentProcessingList: connectionType,
            completedBatches: masterIndex.processingState.completedBatches,
          }) as ProfileInitState;

          await this._updateMasterIndex(masterIndexFile, masterIndex);
        } catch (error) {
          logger.error(`Failed to process ${connectionType} connections:`, error);

          state.lastError = {
            connectionType,
            message: (error as Error).message,
            timestamp: new Date().toISOString(),
          };

          throw error;
        }
      }

      await scrapeAndStoreMessages(this, masterIndexFile);

      await this.dynamoDBService.clearImportCheckpoint?.();

      results.progressSummary = ProfileInitStateManager.getProgressSummary(state);

      logger.info('Connection list processing completed', {
        processed: results.processed,
        skipped: results.skipped,
        errors: results.errors,
        progress: results.progressSummary,
      });

      return results;
    } catch (error) {
      logger.error('Connection list processing failed:', error);
      throw error;
    } finally {
      this.interactionQueue?.setImportMode(false);
      this.backoffController?.setImportMode(false);
    }
  }

  // --- Delegates to domain files ---

  async triggerRAGStackIngestion(profileId: string, state: ProfileInitState): Promise<unknown> {
    return _triggerRAGStackIngestion(this, profileId, state);
  }

  async _createMasterIndexFile(): Promise<string> {
    return _createMasterIndexFile(this);
  }

  async _loadMasterIndex(masterIndexFile: string): Promise<MasterIndex> {
    return _loadMasterIndex(this, masterIndexFile);
  }

  async _updateMasterIndex(masterIndexFile: string, masterIndex: MasterIndex): Promise<void> {
    return _updateMasterIndex(this, masterIndexFile, masterIndex);
  }
}
