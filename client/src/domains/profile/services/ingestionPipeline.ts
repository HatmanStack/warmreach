import { logger } from '#utils/logger.js';
import type { RagstackProxyService } from '../../ragstack/services/ragstackProxyService.js';

/**
 * Minimal state interface needed by the ingestion pipeline.
 */
interface IngestionState {
  requestId?: string;
  jwtToken?: string;
}

/**
 * Options for constructing the IngestionPipeline.
 */
interface IngestionPipelineOptions {
  ragstackProxy: RagstackProxyService;
  generateProfileMarkdown: (profileData: Record<string, unknown>) => string;
}

/**
 * Handles RAGStack ingestion of profile data.
 * Extracted from ProfileInitService for single-responsibility.
 */
export class IngestionPipeline {
  private ragstackProxy: RagstackProxyService;
  private generateProfileMarkdown: (profileData: Record<string, unknown>) => string;

  constructor(options: IngestionPipelineOptions) {
    this.ragstackProxy = options.ragstackProxy;
    this.generateProfileMarkdown = options.generateProfileMarkdown;
  }

  /**
   * Trigger RAGStack ingestion for a profile.
   * Non-fatal: returns null on any error.
   */
  async triggerRAGStackIngestion(profileId: string, state: IngestionState): Promise<unknown> {
    const requestId = state.requestId || 'unknown';

    try {
      if (!this.ragstackProxy.isConfigured()) {
        logger.debug('RAGStack ingestion skipped: API_GATEWAY_BASE_URL not configured', {
          requestId,
          profileId,
        });
        return null;
      }

      // Fetch profile data from DynamoDB via ragstack proxy
      const profileResponse = await this.ragstackProxy.fetchProfile({
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
      const markdown = this.generateProfileMarkdown({
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
      const result = await this.ragstackProxy.ingest({
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
        documentId: (result as Record<string, unknown>)?.documentId,
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
}
