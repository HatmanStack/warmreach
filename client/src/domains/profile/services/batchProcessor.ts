import { logger } from '#utils/logger.js';
import { ProfileInitStateManager } from '../utils/profileInitStateManager.js';
import { profileInitMonitor } from '../utils/profileInitMonitor.js';
import { RandomHelpers } from '#utils/randomHelpers.js';
import { LinkedInErrorHandler } from '../../linkedin/utils/linkedinErrorHandler.js';
import fs from 'fs/promises';
import path from 'path';
import type { PuppeteerService } from '../../automation/services/puppeteerService.js';
import type { LinkedInService, ConnectionType } from '../../linkedin/services/linkedinService.js';
import type { IngestionPipeline } from './ingestionPipeline.js';

/**
 * Profile initialization state (subset needed by BatchProcessor)
 */
interface ProfileInitState {
  requestId?: string;
  recursionCount?: number;
  healPhase?: string;
  currentProcessingList?: string;
  currentBatch?: number;
  currentIndex?: number;
  jwtToken?: string;
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
 * Batch processing result
 */
export interface BatchResult {
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
export interface ConnectionProcessResult {
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
 * Type-specific processing result
 */
export interface TypeResult {
  processed: number;
  skipped: number;
  errors: number;
  batches: BatchResult[];
}

/**
 * Processing result
 */
export interface ProcessingResult {
  processed: number;
  skipped: number;
  errors: number;
  connectionTypes?: Record<string, TypeResult>;
  progressSummary?: unknown;
  batches?: BatchResult[];
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
interface DynamoDBServiceInterface {
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
 * BatchProcessor options
 */
interface BatchProcessorOptions {
  dynamoDBService: DynamoDBServiceInterface;
  linkedInService: LinkedInService;
  localProfileScraper?: LocalProfileScraperInterface | null;
  burstThrottleManager?: BurstThrottleManagerInterface | null;
  interactionQueue?: ImportModeToggle | null;
  backoffController?: ImportModeToggle | null;
  ragstackProxy?: unknown;
  puppeteer: PuppeteerService;
  ingestionPipeline: IngestionPipeline;
  batchSize?: number;
}

/**
 * Handles batch processing of LinkedIn connection lists.
 * Extracted from ProfileInitService for single-responsibility.
 */
export class BatchProcessor {
  private dynamoDBService: DynamoDBServiceInterface;
  private linkedInService: LinkedInService;
  private localProfileScraper: LocalProfileScraperInterface | null;
  private burstThrottleManager: BurstThrottleManagerInterface | null;
  private interactionQueue: ImportModeToggle | null;
  private backoffController: ImportModeToggle | null;
  private puppeteer: PuppeteerService;
  private ingestionPipeline: IngestionPipeline;
  private batchSize: number;

  constructor(options: BatchProcessorOptions) {
    this.dynamoDBService = options.dynamoDBService;
    this.linkedInService = options.linkedInService;
    this.localProfileScraper = options.localProfileScraper || null;
    this.burstThrottleManager = options.burstThrottleManager || null;
    this.interactionQueue = options.interactionQueue || null;
    this.backoffController = options.backoffController || null;
    this.puppeteer = options.puppeteer;
    this.ingestionPipeline = options.ingestionPipeline;
    this.batchSize = options.batchSize || 100;
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
          const typeResult = await this._processConnectionType(connectionType, masterIndex, state);

          results.connectionTypes![connectionType] = typeResult;
          results.processed += typeResult.processed;
          results.skipped += typeResult.skipped;
          results.errors += typeResult.errors;

          state = ProfileInitStateManager.updateBatchProgress(state, {
            currentProcessingList: connectionType,
            completedBatches: masterIndex.processingState.completedBatches,
          });

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

  /**
   * Process connections for a specific type (ally, incoming, outgoing)
   */
  async _processConnectionType(
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

      const connections = await this.linkedInService.getConnections({
        connectionType: connectionType,
        maxScrolls: 15,
      });

      if (!connections || connections.length === 0) {
        logger.info(`No ${connectionType} connections found`);
        return result;
      }

      let pictureUrls: Record<string, string> = {};
      try {
        pictureUrls = await this.puppeteer.extractProfilePictures();
      } catch (error) {
        logger.warn('Failed to extract profile pictures (non-fatal):', error);
      }

      const batchFiles = await this._createBatchFiles(
        connectionType,
        connections,
        masterIndex,
        pictureUrls
      );

      for (let batchIndex = 0; batchIndex < batchFiles.length; batchIndex++) {
        if (state.completedBatches && state.completedBatches.includes(batchIndex)) {
          logger.info(`Skipping completed batch ${batchIndex} for ${connectionType}`);
          continue;
        }

        if (state.currentBatch && batchIndex < state.currentBatch) {
          continue;
        }

        logger.info(`Processing batch ${batchIndex} for ${connectionType}`);
        const batchResult = await this._processBatch(batchFiles[batchIndex]!, state);

        result.processed += batchResult.processed;
        result.skipped += batchResult.skipped;
        result.errors += batchResult.errors;
        result.batches.push(batchResult);

        masterIndex.processingState.currentList = connectionType;
        masterIndex.processingState.currentBatch = batchIndex;
        masterIndex.processingState.completedBatches.push(batchIndex);

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
  async _createBatchFiles(
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
  async _processBatch(batchFilePath: string, state: ProfileInitState): Promise<BatchResult> {
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

      for (let i = 0; i < batchData.connections.length; i++) {
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
          state.currentIndex = i;

          logger.debug(`Processing connection ${i + 1}/${batchData.connections.length}`, {
            requestId,
            batchNumber: batchData.batchNumber,
            connectionIndex: i,
            profileId: connectionProfileId,
            status: connectionStatus,
          });

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

            profileInitMonitor.recordConnection(requestId, connectionProfileId, 'skipped', 0, {
              batchNumber: batchData.batchNumber,
              connectionIndex: i,
              reason: 'Edge already exists',
            });

            continue;
          }

          if (this.burstThrottleManager) {
            await this.burstThrottleManager.waitForNext();
          }

          const pictureUrl = batchData.pictureUrls?.[connectionProfileId];
          await this._processConnection(connectionProfileId, state, connectionStatus, pictureUrl);

          await this.dynamoDBService.saveImportCheckpoint?.({
            batchIndex: batchData.batchNumber,
            lastProfileId: connectionProfileId,
            connectionType: batchData.connectionType,
            processedCount: result.processed + 1,
            totalCount: batchData.connections.length,
            updatedAt: new Date().toISOString(),
          });

          result.processed++;
          result.connections.push({
            profileId: connectionProfileId,
            action: 'processed',
            index: i,
          });

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

          profileInitMonitor.recordConnection(requestId, connectionProfileId, 'error', 0, {
            batchNumber: batchData.batchNumber,
            connectionIndex: i,
            errorType: errorDetails.type,
            errorCategory: errorDetails.category,
            isConnectionLevel: errorDetails.skipConnection || false,
          });

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

          logger.error('Serious error encountered, failing batch', {
            requestId,
            batchNumber: batchData.batchNumber,
            profileId: connectionProfileId,
            errorType: errorDetails.type,
            errorCategory: errorDetails.category,
          });

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
  _isConnectionLevelError(error: Error): boolean {
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
  async _processConnection(
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

      let databaseResult: unknown = null;

      try {
        try {
          const canScrape = (await this.dynamoDBService.canScrapeToday?.()) ?? true;
          if (!canScrape) {
            logger.warn(`Daily scrape cap reached, skipping scrape for ${connectionProfileId}`);
          } else {
            const needsScrape = await this.dynamoDBService.getProfileDetails(connectionProfileId);
            if (needsScrape && this.localProfileScraper) {
              const scrapedData = await this.localProfileScraper.scrapeProfile(connectionProfileId);
              await this.dynamoDBService.createProfileMetadata?.(connectionProfileId, {
                name: scrapedData.name || '',
                headline: scrapedData.headline || '',
                currentTitle: scrapedData.currentPosition?.title || '',
                currentCompany: scrapedData.currentPosition?.company || '',
                currentLocation: scrapedData.location || '',
                ...(pictureUrl ? { profilePictureUrl: pictureUrl } : {}),
              });
              await this.dynamoDBService.incrementDailyScrapeCount?.();
              logger.debug(`Profile scraped locally: ${connectionProfileId}`);
            } else if (!needsScrape) {
              logger.debug(`Profile is fresh, skipping scrape: ${connectionProfileId}`);
            }
          }
        } catch (scrapeErr) {
          logger.warn(`Local scrape failed for ${connectionProfileId} (non-fatal)`, {
            error: (scrapeErr as Error).message,
          });
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

        logger.debug(`Creating database entry for connection: ${connectionProfileId}`, {
          requestId,
          profileId: connectionProfileId,
        });

        databaseResult = await this.dynamoDBService.upsertEdgeStatus(
          connectionProfileId,
          connectionType
        );

        // Trigger RAGStack ingestion (fire-and-forget)
        this.ingestionPipeline.triggerRAGStackIngestion(connectionProfileId, state).catch((err) => {
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

        processingError.context = {
          requestId,
          profileId: connectionProfileId,
          duration: processingDuration,
          errorDetails,
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
   * Load existing links from saved files for healing recovery
   */
  async _loadExistingLinksFromFiles(
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
}
