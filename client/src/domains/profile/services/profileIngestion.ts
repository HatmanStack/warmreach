/**
 * Profile Ingestion - RAGStack ingestion, master index management
 *
 * Extracted from profileInitService.ts as part of domain decomposition.
 * Each function receives the service instance as its first parameter.
 */

import { logger } from '#utils/logger.js';
import { generateProfileMarkdown } from '../utils/profileMarkdownGenerator.js';
import fs from 'fs/promises';
import path from 'path';
import type { MasterIndex, ProfileInitService } from './profileInitService.js';

/**
 * Profile init state (minimal needed for ingestion)
 */
interface ProfileInitState {
  requestId?: string;
  jwtToken?: string;
  [key: string]: unknown;
}

/**
 * Trigger RAGStack ingestion for a profile
 */
export async function triggerRAGStackIngestion(
  service: ProfileInitService,
  profileId: string,
  state: ProfileInitState
): Promise<unknown> {
  const requestId = state.requestId || 'unknown';

  try {
    if (!service.ragstackProxy.isConfigured()) {
      logger.debug('RAGStack ingestion skipped: API_GATEWAY_BASE_URL not configured', {
        requestId,
        profileId,
      });
      return null;
    }

    const profileResponse = await service.ragstackProxy.fetchProfile({
      profileId,
      jwtToken: state.jwtToken,
    });

    if (!profileResponse || !profileResponse.profile) {
      logger.debug('RAGStack ingestion skipped: profile not found in DynamoDB', {
        requestId,
        profileId,
      });
      return null;
    }

    const profile = profileResponse.profile;

    if (profile.ragstack_ingested) {
      logger.debug('RAGStack ingestion skipped: already ingested', {
        requestId,
        profileId,
      });
      return null;
    }

    if (!profile.name) {
      logger.debug('RAGStack ingestion skipped: profile missing required name field', {
        requestId,
        profileId,
      });
      return null;
    }

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

    const result = await service.ragstackProxy.ingest({
      profileId,
      markdownContent: markdown,
      metadata: {
        source: 'profile_init',
        ingested_at: new Date().toISOString(),
      },
      jwtToken: state.jwtToken,
    });

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
 * Create master index file for tracking connection lists
 */
export async function createMasterIndexFile(service: ProfileInitService): Promise<string> {
  try {
    const timestamp = Date.now();
    const masterIndexFile = path.join('data', `profile-init-index-${timestamp}.json`);

    const masterIndex: MasterIndex = {
      metadata: {
        capturedAt: new Date().toISOString(),
        totalAllies: 0,
        totalIncoming: 0,
        totalOutgoing: 0,
        batchSize: service.batchSize,
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
export async function loadMasterIndex(
  _service: ProfileInitService,
  masterIndexFile: string
): Promise<MasterIndex> {
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
export async function updateMasterIndex(
  _service: ProfileInitService,
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
