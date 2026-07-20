/**
 * Profile Scraping - Connection processing and message scraping
 *
 * Extracted from profileInitService.ts as part of domain decomposition.
 * Each function receives the service instance as its first parameter.
 */

import { logger } from '#utils/logger.js';
import { config } from '#shared-config/index.js';
import { LinkedInErrorHandler } from '../../linkedin/utils/linkedinErrorHandler.js';
import type { MasterIndex, ProfileInitService } from './profileInitService.js';

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
 * Profile init state (minimal needed for scraping)
 */
interface ProfileInitState {
  requestId?: string;
  jwtToken?: string;
  currentBatch?: number;
  currentIndex?: number;
  currentProcessingList?: string;
  /** Consent flag (from the profile-init payload) enabling mutual collection. */
  collectMutuals?: boolean;
  [key: string]: unknown;
}

/**
 * Process a single connection profile
 */
export async function processConnection(
  service: ProfileInitService,
  connectionProfileId: string,
  state: ProfileInitState,
  connectionType: string,
  pictureUrl?: string,
  forceScrape = false
): Promise<void> {
  const requestId = state.requestId || 'unknown';
  const startTime = Date.now();

  try {
    logger.info(`[connection] processing ${connectionProfileId}`, {
      phase: 'connection',
      requestId,
      profileId: connectionProfileId,
      connectionType,
      currentBatch: state.currentBatch,
      currentIndex: state.currentIndex,
      hasPictureUrl: !!pictureUrl,
    });

    let databaseResult: unknown = null;

    try {
      // Local scraping with cap and staleness checks
      try {
        const canScrape = (await service.dynamoDBService.canScrapeToday?.()) ?? true;
        logger.debug(`[connection] scrape gate for ${connectionProfileId}`, {
          phase: 'connection',
          profileId: connectionProfileId,
          canScrape,
        });
        if (!canScrape) {
          logger.warn(
            `[connection] daily scrape cap reached, skipping scrape for ${connectionProfileId}`,
            {
              phase: 'connection',
              profileId: connectionProfileId,
            }
          );
        } else {
          const needsScrape = await service.dynamoDBService.getProfileDetails(connectionProfileId);
          const forceRescrape = config.linkedin.forceRescrape === true;
          logger.info(`[connection] staleness check for ${connectionProfileId}`, {
            phase: 'connection',
            profileId: connectionProfileId,
            needsScrape: !!needsScrape,
            forceRescrape,
            forceScrape,
            hasScraper: !!service.localProfileScraper,
          });
          if ((needsScrape || forceRescrape || forceScrape) && service.localProfileScraper) {
            const scrapedData =
              await service.localProfileScraper.scrapeProfile(connectionProfileId);
            const metadata = {
              name: scrapedData.name || '',
              headline: scrapedData.headline || '',
              about: scrapedData.about || '',
              skills: (scrapedData.skills ?? []).join(', '),
              currentTitle: scrapedData.currentPosition?.title || '',
              currentCompany: scrapedData.currentPosition?.company || '',
              currentLocation: scrapedData.location || '',
              education: (scrapedData.education ?? [])
                .map((e) => [e.school, e.degree].filter(Boolean).join(' — '))
                .filter(Boolean)
                .join('; '),
              // Use only the photo scraped from the member's own profile page.
              // The list-page `pictureUrl` map mis-resolves to the viewer's own
              // avatar in the 2026 DOM, so writing it would stamp the same wrong
              // photo on everyone — better to write none and show initials.
              ...(scrapedData.profilePictureUrl
                ? { profilePictureUrl: scrapedData.profilePictureUrl }
                : {}),
            };
            logger.info(`[connection] writing scraped metadata for ${connectionProfileId}`, {
              phase: 'connection',
              profileId: connectionProfileId,
              metadata,
              allTextFieldsEmpty:
                !metadata.name &&
                !metadata.headline &&
                !metadata.currentTitle &&
                !metadata.currentCompany &&
                !metadata.currentLocation,
            });
            await service.dynamoDBService.createProfileMetadata?.(connectionProfileId, metadata);
            await service.dynamoDBService.incrementDailyScrapeCount?.();
            logger.info(`[connection] scraped + metadata stored: ${connectionProfileId}`, {
              phase: 'connection',
              profileId: connectionProfileId,
            });

            // Consented mutual-connections collection, piggybacked on this
            // scrape (ADR-7). A strict no-op unless collectMutuals is set and a
            // collector is injected; never throws into the ingestion loop.
            await collectMutualConnections(service, connectionProfileId, state);
          } else if (!needsScrape) {
            logger.info(`[connection] profile is fresh, skipping scrape: ${connectionProfileId}`, {
              phase: 'connection',
              profileId: connectionProfileId,
            });
          }
        }
      } catch (scrapeErr) {
        logger.warn(
          `[connection] local scrape failed for ${connectionProfileId} (non-fatal, using slug fallback)`,
          {
            phase: 'connection',
            profileId: connectionProfileId,
            error: (scrapeErr as Error).message,
          }
        );
        // Create a basic fallback metadata record
        try {
          const name = connectionProfileId
            .replace(/-\d+$/, '')
            .split('-')
            .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
          logger.info(
            `[connection] writing slug-derived fallback name for ${connectionProfileId}`,
            {
              phase: 'connection',
              profileId: connectionProfileId,
              fallbackName: name,
            }
          );
          // No photo here: the scrape failed, so there's no per-member photo,
          // and the list-page `pictureUrl` is the viewer's own avatar.
          await service.dynamoDBService.createProfileMetadata?.(connectionProfileId, {
            name,
          });
        } catch {
          // non-fatal
        }
      }

      // Create database entry for the connection
      logger.info(`[connection] upserting edge status for ${connectionProfileId}`, {
        phase: 'connection',
        requestId,
        profileId: connectionProfileId,
        connectionType,
      });

      databaseResult = await service.dynamoDBService.upsertEdgeStatus(
        connectionProfileId,
        connectionType
      );

      // Trigger RAGStack ingestion (fire-and-forget)
      logger.debug(`[connection] triggering RAGStack ingestion for ${connectionProfileId}`, {
        phase: 'connection',
        profileId: connectionProfileId,
      });
      service.triggerRAGStackIngestion(connectionProfileId, state).catch((err: Error) => {
        logger.warn('[connection] async RAGStack ingestion failed (non-blocking)', {
          phase: 'connection',
          requestId,
          profileId: connectionProfileId,
          error: err.message,
        });
      });

      const processingDuration = Date.now() - startTime;
      logger.info(`[connection] done: ${connectionProfileId}`, {
        phase: 'connection',
        requestId,
        profileId: connectionProfileId,
        processingDuration,
        databaseSuccess: !!databaseResult,
      });
    } catch (processingErr) {
      const processingError = processingErr as Error & {
        context?: Record<string, unknown>;
      };
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
 * Collect the mutual connections shared with a contact and persist each as a
 * private, per-user adjacency edge (contact <-> shared connection).
 *
 * Consent-gated (ADR-6) and piggybacked on the contact's profile scrape
 * (ADR-7): a strict no-op unless `state.collectMutuals` is true AND a collector
 * is injected on the service. Tie strength is a neutral constant on the backend,
 * so only the discovered edge is sent. Never throws into the ingestion loop —
 * collection and per-edge persistence failures are logged and swallowed.
 */
export async function collectMutualConnections(
  service: ProfileInitService,
  connectionProfileId: string,
  state: ProfileInitState
): Promise<void> {
  if (!state.collectMutuals || !service.mutualConnectionsCollector) {
    return;
  }

  try {
    const shared =
      await service.mutualConnectionsCollector.collectSharedConnections(connectionProfileId);
    for (const conn of shared) {
      try {
        await service.dynamoDBService.upsertAdjacency(connectionProfileId, conn.profileId);
      } catch (persistErr) {
        logger.warn(
          `Failed to persist adjacency ${connectionProfileId} <-> ${conn.profileId} (non-fatal)`,
          { error: (persistErr as Error).message }
        );
      }
    }
  } catch (collectErr) {
    logger.warn(`Mutual-connections collection failed for ${connectionProfileId} (non-fatal)`, {
      error: (collectErr as Error).message,
    });
  }
}

/**
 * Scrape LinkedIn message histories and store them on edges.
 */
export async function scrapeAndStoreMessages(
  service: ProfileInitService,
  masterIndexFile: string
): Promise<void> {
  try {
    logger.info('Starting message history scraping phase');

    const masterIndex = await service._loadMasterIndex(masterIndexFile);
    const allConnectionIds: string[] = [];

    for (const connectionType of ['ally', 'outgoing', 'incoming'] as const) {
      const links = await loadExistingLinksFromFiles(service, connectionType, masterIndex);
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
      await service.messageScraperService.scrapeAllConversations(allConnectionIds);

    if (scrapedMessages.size === 0) {
      logger.info('No message histories scraped');
      return;
    }

    let stored = 0;
    for (const [profileId, messages] of scrapedMessages) {
      try {
        await service.dynamoDBService.updateMessages(profileId, messages);
        stored++;
      } catch (error) {
        logger.warn(`Failed to store messages for ${profileId}: ${(error as Error).message}`);
      }
    }

    logger.info(`Message scraping phase complete: ${stored}/${scrapedMessages.size} stored`);
  } catch (error) {
    logger.warn(`Message scraping phase failed (non-blocking): ${(error as Error).message}`);
  }
}

/**
 * Load existing links from saved files for healing recovery
 */
async function loadExistingLinksFromFiles(
  _service: ProfileInitService,
  connectionType: string,
  masterIndex: MasterIndex
): Promise<string[]> {
  const fs = (await import('fs/promises')).default;
  const path = (await import('path')).default;

  try {
    const connectionKey = `${connectionType}Connections`;
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
 * Determine if an error is connection-specific and shouldn't fail the entire batch
 */
export function isConnectionLevelError(error: Error): boolean {
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
