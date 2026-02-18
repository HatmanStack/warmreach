import { logger } from '#utils/logger.js';
import { ProfileInitStateManager } from '../utils/profileInitStateManager.js';
import { profileInitMonitor } from '../utils/profileInitMonitor.js';
import RandomHelpers from '#utils/randomHelpers.js';
import LinkedInErrorHandler from '../../linkedin/utils/linkedinErrorHandler.js';
import { generateProfileMarkdown } from '../utils/profileMarkdownGenerator.js';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import type { PuppeteerService } from '../../automation/services/puppeteerService.js';
import type { LinkedInService, ConnectionType } from '../../linkedin/services/linkedinService.js';
import { LinkedInMessageScraperService } from '../../messaging/services/linkedinMessageScraperService.js';
import { BrowserSessionManager } from '../../session/services/browserSessionManager.js';

/**
 * Profile initialization state
 */
export interface ProfileInitState {
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
 * Master index file structure
 */
interface MasterIndex {
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
 * Batch data structure
 */
interface BatchData {
  batchNumber: number;
  connectionType: string;
  connections: string[];
  pictureUrls?: Record<string, string>;
  batchMetadata?: {
    startIndex: number;
    endIndex: number;
    capturedAt: string;
  };
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
 * Scrape result
 */
interface ScrapeResult {
  success: boolean;
  message?: string;
  data?: unknown;
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
}

/**
 * LinkedIn contact service interface
 */
interface LinkedInContactService {
  scrapeProfile(profileId: string, status: string): Promise<ScrapeResult>;
  setAuthToken?(token: string): void;
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
 * Handles LinkedIn profile database initialization with batch processing.
 */
export class ProfileInitService {
  private puppeteer: PuppeteerService;
  private linkedInService: LinkedInService;
  private linkedInContactService: LinkedInContactService;
  private dynamoDBService: DynamoDBService;
  private messageScraperService: InstanceType<typeof LinkedInMessageScraperService>;
  private batchSize: number;

  constructor(
    puppeteerService: PuppeteerService,
    linkedInService: LinkedInService,
    linkedInContactService: LinkedInContactService,
    dynamoDBService: DynamoDBService
  ) {
    this.puppeteer = puppeteerService;
    this.linkedInService = linkedInService;
    this.linkedInContactService = linkedInContactService;
    this.dynamoDBService = dynamoDBService;
    this.messageScraperService = new LinkedInMessageScraperService({
      sessionManager: BrowserSessionManager,
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

      // Set auth token for DynamoDB and scrape operations
      if (state.jwtToken) {
        this.dynamoDBService.setAuthToken(state.jwtToken);
        this.linkedInContactService.setAuthToken?.(state.jwtToken);
      }

      // Perform LinkedIn login using existing LinkedInService
      await this.linkedInService.login(
        state.searchName,
        state.searchPassword,
        (state.recursionCount || 0) > 0,
        state.credentialsCiphertext,
        'profile-init'
      );

      // Process connection lists in batches
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
   * Process connection lists with batch processing
   */
  async processConnectionLists(state: ProfileInitState): Promise<ProcessingResult> {
    try {
      logger.info('Starting connection list processing');

      // Validate state using ProfileInitStateManager
      ProfileInitStateManager.validateState(state);

      // Create master index file if not resuming from healing
      let masterIndexFile = state.masterIndexFile;
      if (!masterIndexFile) {
        masterIndexFile = await this._createMasterIndexFile();
        state.masterIndexFile = masterIndexFile;
      }

      // Load existing master index or create new one
      const masterIndex = await this._loadMasterIndex(masterIndexFile);

      // Update total connections in state from master index
      if (masterIndex.metadata) {
        state.totalConnections = {
          ally: masterIndex.metadata.totalAllies || 0,
          incoming: masterIndex.metadata.totalIncoming || 0,
          outgoing: masterIndex.metadata.totalOutgoing || 0,
        };
      }

      // Process each connection type
      const connectionTypes: ConnectionType[] = ['ally', 'outgoing', 'incoming'];
      const results: ProcessingResult = {
        processed: 0,
        skipped: 0,
        errors: 0,
        connectionTypes: {},
        progressSummary: ProfileInitStateManager.getProgressSummary(state),
      };

      // Track what we've processed in this run to prevent duplicates
      const processedInThisRun = new Set<string>();

      for (const connectionType of connectionTypes) {
        // Skip if we've already processed this type in this run
        if (processedInThisRun.has(connectionType)) {
          logger.info(`Skipping ${connectionType} connections - already processed in this run`);
          continue;
        }

        // Skip if we're resuming from a specific list and this isn't it
        if (state.currentProcessingList && state.currentProcessingList !== connectionType) {
          logger.info(
            `Skipping ${connectionType} connections - resuming from ${state.currentProcessingList}`
          );
          continue;
        }

        logger.info(`Processing ${connectionType} connections`);

        // Mark as being processed in this run
        processedInThisRun.add(connectionType);

        try {
          const typeResult = await this._processConnectionType(connectionType, masterIndex, state);

          results.connectionTypes![connectionType] = typeResult;
          results.processed += typeResult.processed;
          results.skipped += typeResult.skipped;
          results.errors += typeResult.errors;

          // Update state with progress
          state = ProfileInitStateManager.updateBatchProgress(state, {
            currentProcessingList: connectionType,
            completedBatches: masterIndex.processingState.completedBatches,
          });

          // Update master index with progress
          await this._updateMasterIndex(masterIndexFile, masterIndex);
        } catch (error) {
          logger.error(`Failed to process ${connectionType} connections:`, error);

          // Update state with error information for potential healing
          state.lastError = {
            connectionType,
            message: (error as Error).message,
            timestamp: new Date().toISOString(),
          };

          throw error;
        }
      }

      // Phase 2: Scrape message histories and update edges
      await this._scrapeAndStoreMessages(masterIndexFile);

      // Update final progress summary
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
    }
  }

  /**
   * Scrape LinkedIn message histories and store them on edges.
   * Runs after edge creation so failures don't block profile init.
   */
  private async _scrapeAndStoreMessages(masterIndexFile: string): Promise<void> {
    try {
      logger.info('Starting message history scraping phase');

      // Collect all connection IDs from batch files in the master index
      const masterIndex = await this._loadMasterIndex(masterIndexFile);
      const allConnectionIds: string[] = [];

      for (const connectionType of ['ally', 'outgoing', 'incoming'] as const) {
        const links = await this._loadExistingLinksFromFiles(connectionType, masterIndex);
        // Convert URLs to profile IDs if needed
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

  /**
   * Create master index file for tracking connection lists
   */
  private async _createMasterIndexFile(): Promise<string> {
    try {
      const timestamp = Date.now();
      const masterIndexFile = path.join('data', `profile-init-index-${timestamp}.json`);

      const masterIndex: MasterIndex = {
        metadata: {
          capturedAt: new Date().toISOString(),
          totalAllies: 0,
          totalIncoming: 0,
          totalOutgoing: 0,
          batchSize: this.batchSize,
        },
        files: {
          allyConnections: [],
          incomingConnections: [],
          outgoingConnections: [],
        },
        processingState: {
          currentList: 'ally',
          currentBatch: 0,
          currentIndex: 0,
          completedBatches: [],
        },
      };

      await fs.writeFile(masterIndexFile, JSON.stringify(masterIndex, null, 2));
      logger.info(`Created master index file: ${masterIndexFile}`);

      return masterIndexFile;
    } catch (error) {
      logger.error('Failed to create master index file:', error);
      throw error;
    }
  }

  /**
   * Load master index from file
   */
  private async _loadMasterIndex(masterIndexFile: string): Promise<MasterIndex> {
    try {
      const content = await fs.readFile(masterIndexFile, 'utf8');
      return JSON.parse(content) as MasterIndex;
    } catch (error) {
      logger.error(`Failed to load master index from ${masterIndexFile}:`, error);
      throw error;
    }
  }

  /**
   * Update master index file with current progress
   */
  private async _updateMasterIndex(
    masterIndexFile: string,
    masterIndex: MasterIndex
  ): Promise<void> {
    try {
      await fs.writeFile(masterIndexFile, JSON.stringify(masterIndex, null, 2));
      logger.debug(`Updated master index file: ${masterIndexFile}`);
    } catch (error) {
      logger.error('Failed to update master index:', error);
      throw error;
    }
  }

  /**
   * Process connections for a specific type (ally, incoming, outgoing)
   */
  private async _processConnectionType(
    connectionType: ConnectionType,
    masterIndex: MasterIndex,
    state: ProfileInitState
  ): Promise<TypeResult> {
    try {
      logger.info(`Processing ${connectionType} connections`);

      const result: TypeResult = {
        processed: 0,
        skipped: 0,
        errors: 0,
        batches: [],
      };

      // Get connections using LinkedInService
      const connections = await this.linkedInService.getConnections({
        connectionType: connectionType,
        maxScrolls: 15,
      });

      if (!connections || connections.length === 0) {
        logger.info(`No ${connectionType} connections found`);
        return result;
      }

      // Extract profile picture URLs while still on the connections list page
      let pictureUrls: Record<string, string> = {};
      try {
        pictureUrls = await this.puppeteer.extractProfilePictures();
      } catch (error) {
        logger.warn('Failed to extract profile pictures (non-fatal):', error);
      }

      // Create batch files
      const batchFiles = await this._createBatchFiles(
        connectionType,
        connections,
        masterIndex,
        pictureUrls
      );

      // Process each batch
      for (let batchIndex = 0; batchIndex < batchFiles.length; batchIndex++) {
        // Skip completed batches if resuming
        if (state.completedBatches && state.completedBatches.includes(batchIndex)) {
          logger.info(`Skipping completed batch ${batchIndex} for ${connectionType}`);
          continue;
        }

        // Skip if resuming from a later batch
        if (state.currentBatch && batchIndex < state.currentBatch) {
          continue;
        }

        logger.info(`Processing batch ${batchIndex} for ${connectionType}`);
        const batchResult = await this._processBatch(batchFiles[batchIndex]!, state);

        result.processed += batchResult.processed;
        result.skipped += batchResult.skipped;
        result.errors += batchResult.errors;
        result.batches.push(batchResult);

        // Update progress in master index
        masterIndex.processingState.currentList = connectionType;
        masterIndex.processingState.currentBatch = batchIndex;
        masterIndex.processingState.completedBatches.push(batchIndex);

        // Add random delay between batches to respect LinkedIn rate limits
        await RandomHelpers.randomDelay(2000, 5000);
      }

      logger.info(`Completed processing ${connectionType} connections:`, result);
      return result;
    } catch (error) {
      logger.error(`Failed to process ${connectionType} connections:`, error);
      throw error;
    }
  }

  /**
   * Create batch files for a connection type
   */
  private async _createBatchFiles(
    connectionType: ConnectionType,
    connections: string[],
    masterIndex: MasterIndex,
    pictureUrls?: Record<string, string>
  ): Promise<string[]> {
    try {
      const batchFiles: string[] = [];
      const totalBatches = Math.ceil(connections.length / this.batchSize);

      for (let i = 0; i < totalBatches; i++) {
        const startIndex = i * this.batchSize;
        const endIndex = Math.min(startIndex + this.batchSize, connections.length);
        const batchConnections = connections.slice(startIndex, endIndex);

        const batchFileName = `${connectionType}-connections-batch-${i}.json`;
        const batchFilePath = path.join('data', batchFileName);

        const batchData: BatchData = {
          batchNumber: i,
          connectionType: connectionType,
          connections: batchConnections,
          ...(pictureUrls && Object.keys(pictureUrls).length > 0 ? { pictureUrls } : {}),
          batchMetadata: {
            startIndex: startIndex,
            endIndex: endIndex - 1,
            capturedAt: new Date().toISOString(),
          },
        };

        await fs.writeFile(batchFilePath, JSON.stringify(batchData, null, 2));
        batchFiles.push(batchFilePath);

        // Update master index with batch file reference
        const connectionKey = `${connectionType}Connections` as keyof MasterIndex['files'];
        if (!masterIndex.files[connectionKey]) {
          masterIndex.files[connectionKey] = [];
        }
        masterIndex.files[connectionKey].push({ fileName: batchFileName });
      }

      logger.info(`Created ${batchFiles.length} batch files for ${connectionType} connections`);
      return batchFiles;
    } catch (error) {
      logger.error(`Failed to create batch files for ${connectionType}:`, error);
      throw error;
    }
  }

  /**
   * Process a single batch file
   */
  private async _processBatch(
    batchFilePath: string,
    state: ProfileInitState
  ): Promise<BatchResult> {
    const requestId = state.requestId || 'unknown';
    const startTime = Date.now();
    let batchData: BatchData | null = null;

    try {
      logger.info(`Processing batch file: ${batchFilePath}`, {
        requestId,
        batchFilePath,
        currentIndex: state.currentIndex,
        recursionCount: state.recursionCount,
      });

      // Load batch data with error handling
      try {
        const batchContent = await fs.readFile(batchFilePath, 'utf8');
        batchData = JSON.parse(batchContent) as BatchData;
      } catch (fileError) {
        logger.error(`Failed to load batch file: ${batchFilePath}`, {
          requestId,
          batchFilePath,
          error: (fileError as Error).message,
        });
        throw new Error(`Batch file loading failed: ${(fileError as Error).message}`);
      }

      const result: BatchResult = {
        batchNumber: batchData.batchNumber,
        batchFilePath,
        processed: 0,
        skipped: 0,
        errors: 0,
        connections: [],
        startTime: new Date().toISOString(),
      };

      logger.info('Starting batch processing', {
        requestId,
        batchNumber: batchData.batchNumber,
        totalConnections: batchData.connections.length,
        resumingFromIndex: state.currentIndex || 0,
      });

      // Process each connection in the batch
      for (let i = 0; i < batchData.connections.length; i++) {
        // Skip if resuming from a specific index
        if (state.currentIndex && i < state.currentIndex) {
          logger.debug(
            `Skipping connection at index ${i} - resuming from index ${state.currentIndex}`,
            {
              requestId,
              batchNumber: batchData.batchNumber,
              skipIndex: i,
              resumeIndex: state.currentIndex,
            }
          );
          continue;
        }

        const connectionProfileId = batchData.connections[i]!;
        const connectionStatus = batchData.connectionType;

        try {
          // Update current processing index in state for recovery
          state.currentIndex = i;

          logger.debug(`Processing connection ${i + 1}/${batchData.connections.length}`, {
            requestId,
            batchNumber: batchData.batchNumber,
            connectionIndex: i,
            profileId: connectionProfileId,
            status: connectionStatus,
          });

          // Check if edge already exists to avoid reprocessing
          const edgeExists = await this.dynamoDBService.checkEdgeExists(connectionProfileId);

          if (edgeExists) {
            logger.debug(`Skipping ${connectionProfileId}: Edge already exists`);

            result.skipped++;
            result.connections.push({
              profileId: connectionProfileId,
              action: 'skipped',
              reason: 'Edge already exists',
              index: i,
            });

            // Record skipped connection in monitoring
            profileInitMonitor.recordConnection(requestId, connectionProfileId, 'skipped', 0, {
              batchNumber: batchData.batchNumber,
              connectionIndex: i,
              reason: 'Edge already exists',
            });

            continue;
          }

          // Process the connection (create database entry)
          const pictureUrl = batchData.pictureUrls?.[connectionProfileId];
          await this._processConnection(connectionProfileId, state, connectionStatus, pictureUrl);

          result.processed++;
          result.connections.push({
            profileId: connectionProfileId,
            action: 'processed',
            index: i,
          });

          // Record successful connection processing in monitoring
          profileInitMonitor.recordConnection(requestId, connectionProfileId, 'processed', 0, {
            batchNumber: batchData.batchNumber,
            connectionIndex: i,
            batchProgress: `${i + 1}/${batchData.connections.length}`,
          });

          logger.debug(`Successfully processed connection ${connectionProfileId} at index ${i}`, {
            requestId,
            profileId: connectionProfileId,
            connectionIndex: i,
            batchProgress: `${i + 1}/${batchData.connections.length}`,
          });
        } catch (err) {
          const error = err as Error & { context?: Record<string, unknown> };
          const errorDetails = LinkedInErrorHandler.categorizeError(error) as ErrorDetails;

          logger.error(`Failed to process connection ${connectionProfileId} at index ${i}`, {
            requestId,
            profileId: connectionProfileId,
            connectionIndex: i,
            errorType: errorDetails.type,
            errorCategory: errorDetails.category,
            message: error.message,
            isConnectionLevel: errorDetails.skipConnection || false,
            batchNumber: batchData.batchNumber,
          });

          result.errors++;
          result.connections.push({
            profileId: connectionProfileId,
            status: 'error',
            error: error.message,
            errorType: errorDetails.type,
            errorCategory: errorDetails.category,
            index: i,
          });

          // Record error connection in monitoring
          profileInitMonitor.recordConnection(requestId, connectionProfileId, 'error', 0, {
            batchNumber: batchData.batchNumber,
            connectionIndex: i,
            errorType: errorDetails.type,
            errorCategory: errorDetails.category,
            isConnectionLevel: errorDetails.skipConnection || false,
          });

          // For certain errors, we might want to continue processing other connections
          if (this._isConnectionLevelError(error)) {
            logger.warn(
              `Connection-level error for ${connectionProfileId}, continuing with next connection`,
              {
                requestId,
                profileId: connectionProfileId,
                errorType: errorDetails.type,
                continuingBatch: true,
              }
            );
            continue;
          }

          // For more serious errors, we should fail the batch
          logger.error('Serious error encountered, failing batch', {
            requestId,
            batchNumber: batchData.batchNumber,
            profileId: connectionProfileId,
            errorType: errorDetails.type,
            errorCategory: errorDetails.category,
          });

          // Add batch context to error
          error.context = {
            ...error.context,
            batchNumber: batchData.batchNumber,
            batchFilePath,
            connectionIndex: i,
            totalConnections: batchData.connections.length,
            processedSoFar: result.processed,
            skippedSoFar: result.skipped,
            errorsSoFar: result.errors,
          };

          throw error;
        }
      }

      // Reset current index after successful batch completion
      state.currentIndex = 0;

      const batchDuration = Date.now() - startTime;
      result.endTime = new Date().toISOString();
      result.duration = batchDuration;

      logger.info('Batch processing completed successfully', {
        requestId,
        batchNumber: result.batchNumber,
        batchDuration,
        processed: result.processed,
        skipped: result.skipped,
        errors: result.errors,
        totalConnections: batchData.connections.length,
        successRate:
          batchData.connections.length > 0
            ? ((result.processed / batchData.connections.length) * 100).toFixed(2) + '%'
            : '0%',
      });

      return result;
    } catch (err) {
      const error = err as Error & { context?: Record<string, unknown> };
      const batchDuration = Date.now() - startTime;

      logger.error(`Failed to process batch ${batchFilePath}`, {
        requestId,
        batchFilePath,
        batchDuration,
        batchNumber: batchData?.batchNumber || 'unknown',
        message: error.message,
        stack: error.stack,
        currentIndex: state.currentIndex,
        recursionCount: state.recursionCount,
      });

      // Add batch context to error if not already present
      if (!error.context) {
        error.context = {};
      }

      error.context = {
        ...error.context,
        batchFilePath,
        batchNumber: batchData?.batchNumber || 'unknown',
        batchDuration,
        currentIndex: state.currentIndex,
        recursionCount: state.recursionCount,
      };

      throw error;
    }
  }

  /**
   * Determine if an error is connection-specific and shouldn't fail the entire batch
   */
  private _isConnectionLevelError(error: Error): boolean {
    const connectionLevelErrors = [
      /profile.*not.*found/i,
      /profile.*private/i,
      /profile.*unavailable/i,
      /scrape.*failed/i,
      /invalid.*profile/i,
      /profile.*deleted/i,
    ];

    const errorMessage = error.message || error.toString();
    return connectionLevelErrors.some((pattern) => pattern.test(errorMessage));
  }

  /**
   * Process a single connection profile
   */
  private async _processConnection(
    connectionProfileId: string,
    state: ProfileInitState,
    connectionType: string,
    pictureUrl?: string
  ): Promise<void> {
    const requestId = state.requestId || 'unknown';
    const startTime = Date.now();

    try {
      logger.debug(`Processing connection: ${connectionProfileId}`, {
        requestId,
        profileId: connectionProfileId,
        currentBatch: state.currentBatch,
        currentIndex: state.currentIndex,
      });

      let scrapeResult: ScrapeResult | null = null;
      let databaseResult: unknown = null;

      try {
        const testingMode = process.env.LINKEDIN_TESTING_MODE === 'true';

        if (testingMode) {
          // In testing mode, skip RAGStack scrape (it would try real linkedin.com)
          // and create fallback metadata directly from the profileId
          logger.debug(
            `Testing mode: skipping scrape, creating fallback metadata for ${connectionProfileId}`,
            {
              requestId,
              profileId: connectionProfileId,
            }
          );
          try {
            const name = connectionProfileId
              .replace(/-\d+$/, '')
              .split('-')
              .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(' ');
            await this.dynamoDBService.createProfileMetadata?.(connectionProfileId, {
              name,
              currentTitle: 'Mock Title',
              currentCompany: 'Mock Company',
              headline: `${name} - Mock Profile`,
              ...(pictureUrl ? { profilePictureUrl: pictureUrl } : {}),
            });
          } catch {
            // non-fatal
          }
        } else {
          // Production: scrape profile using RAGStack
          logger.debug(`Initiating profile scrape for connection: ${connectionProfileId}`, {
            requestId,
            profileId: connectionProfileId,
          });

          scrapeResult = await this.performProfileScrape(connectionProfileId, connectionType);

          if (scrapeResult && scrapeResult.success) {
            logger.debug(`Profile scrape successful for ${connectionProfileId}`, {
              requestId,
              profileId: connectionProfileId,
            });
          } else {
            logger.warn(`Profile scrape failed for ${connectionProfileId}`, {
              requestId,
              profileId: connectionProfileId,
              reason: scrapeResult?.message || 'Unknown scrape error',
            });

            // Create a basic metadata record so the connection isn't blank
            try {
              const name = connectionProfileId
                .replace(/-\d+$/, '')
                .split('-')
                .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
                .join(' ');
              await this.dynamoDBService.createProfileMetadata?.(connectionProfileId, {
                name,
                ...(pictureUrl ? { profilePictureUrl: pictureUrl } : {}),
              });
            } catch {
              // non-fatal
            }
          }
        }

        // Create database entry for the connection
        logger.debug(`Creating database entry for connection: ${connectionProfileId}`, {
          requestId,
          profileId: connectionProfileId,
        });

        databaseResult = await this.dynamoDBService.upsertEdgeStatus(
          connectionProfileId,
          connectionType
        );

        // Trigger RAGStack ingestion (fire-and-forget)
        this.triggerRAGStackIngestion(connectionProfileId, state).catch((err) => {
          logger.debug('Async RAGStack ingestion failed (non-blocking)', {
            requestId,
            profileId: connectionProfileId,
            error: (err as Error).message,
          });
        });

        const processingDuration = Date.now() - startTime;
        logger.debug(`Successfully processed connection: ${connectionProfileId}`, {
          requestId,
          profileId: connectionProfileId,
          processingDuration,
          scrapeSuccess: scrapeResult?.success || false,
          databaseSuccess: !!databaseResult,
        });
      } catch (processingErr) {
        const processingError = processingErr as Error & { context?: Record<string, unknown> };
        const processingDuration = Date.now() - startTime;
        const errorDetails = LinkedInErrorHandler.categorizeError(processingError) as ErrorDetails;

        logger.error(`Failed to process connection ${connectionProfileId}`, {
          requestId,
          profileId: connectionProfileId,
          processingDuration,
          errorType: errorDetails.type,
          errorCategory: errorDetails.category,
          message: processingError.message,
          isConnectionLevel: errorDetails.skipConnection || false,
          currentBatch: state.currentBatch,
          currentIndex: state.currentIndex,
        });

        // Add context to the error
        processingError.context = {
          requestId,
          profileId: connectionProfileId,
          duration: processingDuration,
          errorDetails,
          scrapeAttempted: !!scrapeResult,
          scrapeSuccess: scrapeResult?.success || false,
          databaseAttempted: !!databaseResult,
        };

        throw processingError;
      }
    } catch (error) {
      const totalDuration = Date.now() - startTime;

      logger.error(`Connection processing failed for ${connectionProfileId}`, {
        requestId,
        profileId: connectionProfileId,
        totalDuration,
        message: (error as Error).message,
        stack: (error as Error).stack,
        currentState: {
          batch: state.currentBatch,
          index: state.currentIndex,
          processingList: state.currentProcessingList,
        },
      });

      throw error;
    }
  }

  /**
   * Scrape profile using RAGStack via LinkedInContactService
   */
  async performProfileScrape(profileId: string, status: string = 'ally'): Promise<ScrapeResult> {
    try {
      logger.info(`Initiating RAGStack scrape for: ${profileId}`);

      const result = await this.linkedInContactService.scrapeProfile(profileId, status);

      logger.info(`RAGStack scrape completed for: ${profileId}`);
      return result;
    } catch (error) {
      logger.error(`Failed to scrape profile ${profileId}:`, error);
      throw error;
    }
  }

  /**
   * Load existing links from saved files for healing recovery
   */
  private async _loadExistingLinksFromFiles(
    connectionType: string,
    masterIndex: MasterIndex
  ): Promise<string[]> {
    try {
      const connectionKey = `${connectionType}Connections` as keyof MasterIndex['files'];
      const fileReferences = masterIndex.files[connectionKey] || [];
      const allLinks: string[] = [];

      for (const fileRef of fileReferences) {
        try {
          const filePath = path.join('data', fileRef.fileName);
          const fileContent = await fs.readFile(filePath, 'utf8');
          const fileData = JSON.parse(fileContent) as {
            links?: string[];
            invitations?: Array<{ originalUrl?: string; profileId?: string }>;
            connections?: string[] | Array<{ url?: string; id?: string; profileId?: string }>;
          };

          if (fileData.links) {
            allLinks.push(...fileData.links);
          } else if (fileData.invitations) {
            allLinks.push(
              ...fileData.invitations.map((inv) => inv.originalUrl || `/in/${inv.profileId}`)
            );
          } else if (fileData.connections) {
            for (const conn of fileData.connections) {
              if (typeof conn === 'string') {
                allLinks.push(conn);
              } else if (conn.url || conn.id || conn.profileId) {
                allLinks.push(conn.url || `/in/${conn.id || conn.profileId}`);
              }
            }
          }
        } catch (fileError) {
          logger.warn(`Failed to load file ${fileRef.fileName}:`, (fileError as Error).message);
        }
      }

      logger.info(
        `Loaded ${allLinks.length} existing ${connectionType} links from ${fileReferences.length} files`
      );
      return allLinks;
    } catch (error) {
      logger.error(`Failed to load existing ${connectionType} links:`, error);
      throw error;
    }
  }

  async triggerRAGStackIngestion(profileId: string, state: ProfileInitState): Promise<unknown> {
    const requestId = state.requestId || 'unknown';

    try {
      const apiBaseUrl = getApiBaseUrl();
      if (!apiBaseUrl) {
        logger.debug('RAGStack ingestion skipped: API_GATEWAY_BASE_URL not configured', {
          requestId,
          profileId,
        });
        return null;
      }

      // Fetch profile data from DynamoDB
      const profileResponse = await this._fetchProfileForIngestion(profileId, state);

      if (!profileResponse || !profileResponse.profile) {
        logger.debug('RAGStack ingestion skipped: profile not found in DynamoDB', {
          requestId,
          profileId,
        });
        return null;
      }

      const profile = profileResponse.profile;

      // Check if already ingested
      if (profile.ragstack_ingested) {
        logger.debug('RAGStack ingestion skipped: already ingested', {
          requestId,
          profileId,
        });
        return null;
      }

      // Check if profile has minimum required data
      if (!profile.name) {
        logger.debug('RAGStack ingestion skipped: profile missing required name field', {
          requestId,
          profileId,
        });
        return null;
      }

      // Generate markdown
      const markdown = generateProfileMarkdown({
        name: profile.name,
        headline: profile.headline || profile.currentTitle,
        location: profile.location || profile.currentLocation,
        profile_id: profileId,
        about: profile.about || profile.summary,
        current_position: profile.currentTitle
          ? {
              title: profile.currentTitle,
              company: profile.currentCompany,
            }
          : profile.current_position,
        experience: profile.experience,
        education: profile.education,
        skills: profile.skills,
      });

      // Call RAGStack proxy to ingest
      const result = await this._callRAGStackProxy(
        {
          operation: 'ingest',
          profileId: profileId,
          markdownContent: markdown,
          metadata: {
            source: 'profile_init',
            ingested_at: new Date().toISOString(),
          },
        },
        state
      );

      logger.info('RAGStack ingestion triggered successfully', {
        requestId,
        profileId,
        documentId: result?.documentId,
      });

      return result;
    } catch (error) {
      logger.warn('RAGStack ingestion failed (non-fatal)', {
        requestId,
        profileId,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Fetch profile data from DynamoDB for ingestion
   */
  private async _fetchProfileForIngestion(
    profileId: string,
    state: ProfileInitState
  ): Promise<{ profile?: Record<string, unknown> } | null> {
    try {
      const apiBaseUrl = getApiBaseUrl();
      if (!apiBaseUrl) return null;

      const response = await axios.get(`${apiBaseUrl}profiles`, {
        params: { profileId },
        headers: {
          'Content-Type': 'application/json',
          ...(state.jwtToken && { Authorization: `Bearer ${state.jwtToken}` }),
        },
      });

      return response.data;
    } catch (error) {
      logger.debug('Failed to fetch profile for ingestion', {
        profileId,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Call RAGStack proxy Lambda
   */
  private async _callRAGStackProxy(
    payload: Record<string, unknown>,
    state: ProfileInitState
  ): Promise<{ documentId?: string } | null> {
    const apiBaseUrl = getApiBaseUrl();
    if (!apiBaseUrl) {
      throw new Error('API_GATEWAY_BASE_URL not configured');
    }

    const response = await axios.post(`${apiBaseUrl}ragstack`, payload, {
      headers: {
        'Content-Type': 'application/json',
        ...(state.jwtToken && { Authorization: `Bearer ${state.jwtToken}` }),
      },
    });

    return response.data;
  }
}

export default ProfileInitService;
