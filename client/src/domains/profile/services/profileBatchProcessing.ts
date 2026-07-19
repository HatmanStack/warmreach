/**
 * Profile Batch Processing - Batch creation, processing, connection type iteration
 *
 * Extracted from profileInitService.ts as part of domain decomposition.
 * Each function receives the service instance as its first parameter.
 */

import { logger } from '#utils/logger.js';
import { config } from '#shared-config/index.js';
import { LinkedInErrorHandler } from '../../linkedin/utils/linkedinErrorHandler.js';
import { RandomHelpers } from '#utils/randomHelpers.js';
import { profileInitMonitor } from '../utils/profileInitMonitor.js';
import { processConnection, isConnectionLevelError } from './profileScraping.js';
import fs from 'fs/promises';
import path from 'path';
import type { MasterIndex, ProfileInitService } from './profileInitService.js';
import type { ConnectionType } from '../../linkedin/services/linkedinService.js';

/**
 * Error details from categorization
 */
interface ErrorDetails {
  type?: string;
  category: string;
  severity?: string;
  isRecoverable?: boolean;
  skipConnection?: boolean;
}

/**
 * Profile init state
 */
interface ProfileInitState {
  requestId?: string;
  jwtToken?: string;
  currentBatch?: number;
  currentIndex?: number;
  currentProcessingList?: string;
  completedBatches?: number[];
  recursionCount?: number;
  [key: string]: unknown;
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
 * Process connections for a specific type (ally, incoming, outgoing)
 */
export async function processConnectionType(
  service: ProfileInitService,
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

    const connections = await service.linkedInService.getConnections({
      connectionType: connectionType,
      maxScrolls: 15,
    });

    logger.info(`[type] retrieved ${connections?.length ?? 0} ${connectionType} connection ids`, {
      phase: 'type',
      connectionType,
      count: connections?.length ?? 0,
      sample: (connections ?? []).slice(0, 5),
    });

    if (!connections || connections.length === 0) {
      logger.info(`No ${connectionType} connections found`);
      return result;
    }

    let pictureUrls: Record<string, string> = {};
    try {
      pictureUrls = await service.puppeteer.extractProfilePictures();
      logger.info(
        `[type] extracted ${Object.keys(pictureUrls).length} profile pictures for ${connectionType}`,
        {
          phase: 'type',
          connectionType,
          pictureCount: Object.keys(pictureUrls).length,
        }
      );
    } catch (error) {
      logger.warn('Failed to extract profile pictures (non-fatal):', error);
    }

    const batchFiles = await createBatchFiles(
      service,
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
      const batchResult = await processBatch(service, batchFiles[batchIndex]!, state);

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
export async function createBatchFiles(
  service: ProfileInitService,
  connectionType: ConnectionType,
  connections: string[],
  masterIndex: MasterIndex,
  pictureUrls?: Record<string, string>
): Promise<string[]> {
  try {
    const batchSize = service.batchSize;
    const batchFiles: string[] = [];
    const totalBatches = Math.ceil(connections.length / batchSize);

    for (let i = 0; i < totalBatches; i++) {
      const startIndex = i * batchSize;
      const endIndex = Math.min(startIndex + batchSize, connections.length);
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

      const connectionKey = `${connectionType}Connections`;
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
export async function processBatch(
  service: ProfileInitService,
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

        logger.info(
          `[batch] connection ${i + 1}/${batchData.connections.length}: ${connectionProfileId}`,
          {
            phase: 'batch',
            requestId,
            batchNumber: batchData.batchNumber,
            connectionIndex: i,
            profileId: connectionProfileId,
            status: connectionStatus,
          }
        );

        const {
          exists: edgeExists,
          status: storedStatus,
          hasName: storedHasName,
        } = await service.dynamoDBService.getEdgeState(connectionProfileId);
        const forceRescrape = config.linkedin.forceRescrape === true;

        // Conversion: a search-sourced contact (possible/outgoing) now appearing
        // in the Connections (ally) list has just become a 1st-degree connection.
        // That unlocks richer profile data (contact info, full about, mutuals),
        // so re-scrape + enrich to equip first contact instead of skipping. Only
        // the promotion INTO 'ally' is treated as a conversion — other
        // already-synced edges still short-circuit for efficiency.
        const isConversionToAlly =
          edgeExists &&
          connectionStatus === 'ally' &&
          (storedStatus === 'possible' || storedStatus === 'outgoing');

        // Backfill: an ally edge created before the scraper was wired stored no
        // name (blank/slug-derived). The old always-false edge check used to
        // re-scrape everything and quietly repaired these; now that the check is
        // correct they would be skipped and stay blank forever. Re-scrape an
        // existing ally the backend reports as nameless so the heal survives.
        const isBlankNameAlly =
          edgeExists &&
          connectionStatus === 'ally' &&
          storedStatus === 'ally' &&
          storedHasName === false;

        const needsRescrape = forceRescrape || isConversionToAlly || isBlankNameAlly;

        logger.info(`[batch] edge-exists check for ${connectionProfileId}: ${edgeExists}`, {
          phase: 'batch',
          profileId: connectionProfileId,
          edgeExists,
          storedStatus,
          storedHasName,
          connectionStatus,
          isConversionToAlly,
          isBlankNameAlly,
          forceRescrape,
        });

        if (edgeExists && needsRescrape) {
          const reason = isConversionToAlly
            ? `converted ${storedStatus} -> ally`
            : isBlankNameAlly
              ? 'existing ally has no stored name'
              : 'forceRescrape is on';
          logger.info(`[batch] re-scraping ${connectionProfileId}: ${reason}`, {
            phase: 'batch',
            profileId: connectionProfileId,
          });
        }

        if (edgeExists && !needsRescrape) {
          // An already-synced edge short-circuits the scrape below. If a prior
          // run created edges with empty names, those connections are skipped
          // here and never re-scraped (forceRescrape heals them) — this log
          // makes that visible.
          logger.info(
            `[batch] skipping ${connectionProfileId}: edge already exists (no re-scrape)`,
            {
              phase: 'batch',
              profileId: connectionProfileId,
            }
          );

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

        if (service.burstThrottleManager) {
          await service.burstThrottleManager.waitForNext();
        }

        const pictureUrl = batchData.pictureUrls?.[connectionProfileId];
        // Force the scrape (bypassing the <30d staleness skip) when the now-
        // unlocked 1st-degree data must be captured: on a conversion to ally, or
        // when re-scraping an existing ally whose name was never stored.
        await processConnection(
          service,
          connectionProfileId,
          state,
          connectionStatus,
          pictureUrl,
          isConversionToAlly || isBlankNameAlly
        );

        await service.dynamoDBService.saveImportCheckpoint?.({
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

        logger.info(`[batch] processed ${connectionProfileId} at index ${i}`, {
          phase: 'batch',
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

        if (isConnectionLevelError(error)) {
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
