/**
 * LinkedIn Contact Service
 *
 * Handles LinkedIn profile data collection by proxying RAGStack scrape
 * operations through the edge-processing Lambda.
 */

import { logger } from '#utils/logger.js';
import { extractLinkedInCookies } from '../../ragstack/index.js';
import axios from 'axios';
import type { PuppeteerService } from '../../automation/services/puppeteerService.js';

/** Terminal scrape job statuses */
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/**
 * Result of a profile scrape operation
 */
export interface ScrapeProfileResult {
  success: boolean;
  message: string;
  profileId: string;
  jobId?: string;
  scrapeJob?: {
    jobId: string;
    baseUrl: string;
    status: string;
    totalUrls: number;
    processedCount: number;
    failedCount: number;
  };
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
 * Service for LinkedIn contact data collection via Lambda-proxied RAGStack scraping
 */
export class LinkedInContactService {
  private puppeteer: PuppeteerService;
  private apiBaseUrl: string | undefined;
  private jwtToken: string | undefined;

  constructor(puppeteerService: PuppeteerService) {
    this.puppeteer = puppeteerService;
    this.apiBaseUrl = getApiBaseUrl();

    if (!this.apiBaseUrl) {
      logger.warn('API_GATEWAY_BASE_URL not configured. Profile scraping disabled.');
    }
  }

  /**
   * Set the JWT token for authenticated Lambda calls.
   */
  setAuthToken(token: string): void {
    this.jwtToken = token;
  }

  /**
   * Scrape a LinkedIn profile via the Lambda proxy.
   *
   * @param profileId - LinkedIn profile ID (e.g., "john-doe")
   * @param status - Connection status (for metadata, not used in scraping)
   * @returns Scrape result with job details
   */
  async scrapeProfile(
    profileId: string,
    status: string = 'possible'
  ): Promise<ScrapeProfileResult> {
    if (!this.apiBaseUrl) {
      return {
        success: false,
        message: 'API_GATEWAY_BASE_URL not configured',
        profileId,
      };
    }

    const page = this.puppeteer.getPage();
    if (!page) {
      return {
        success: false,
        message: 'Browser not initialized',
        profileId,
      };
    }

    try {
      logger.info(`Starting Lambda-proxied scrape for profile: ${profileId}`, { status });

      // Extract cookies from current session
      const cookies = await extractLinkedInCookies(page);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.jwtToken) {
        headers['Authorization'] = `Bearer ${this.jwtToken}`;
      }

      const ragstackUrl = `${this.apiBaseUrl}ragstack`;

      // Start scrape job via Lambda
      const startResponse = await axios.post(
        ragstackUrl,
        { operation: 'scrape_start', profileId, cookies },
        { headers }
      );
      const job = startResponse.data;
      logger.info(`Scrape job started: ${job.jobId}`, { profileId, status: job.status });

      // Poll for completion
      const pollInterval = 3000;
      const timeout = 180000;
      const deadline = Date.now() + timeout;
      let finalJob = job;

      while (!TERMINAL_STATUSES.has(finalJob.status) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        const statusResponse = await axios.post(
          ragstackUrl,
          { operation: 'scrape_status', jobId: job.jobId },
          { headers }
        );
        finalJob = statusResponse.data;
      }

      if (!TERMINAL_STATUSES.has(finalJob.status)) {
        return {
          success: false,
          message: `Scrape timed out after ${timeout / 1000}s (status: ${finalJob.status})`,
          profileId,
          jobId: job.jobId,
          scrapeJob: finalJob,
        };
      }

      const success = finalJob.status === 'COMPLETED';

      logger.info(`Scrape job ${success ? 'completed' : 'failed'}: ${job.jobId}`, {
        profileId,
        status: finalJob.status,
        processedCount: finalJob.processedCount,
        totalUrls: finalJob.totalUrls,
      });

      return {
        success,
        message: success
          ? `Profile scraped successfully (${finalJob.processedCount} pages)`
          : `Scrape failed with status: ${finalJob.status}`,
        profileId,
        jobId: job.jobId,
        scrapeJob: finalJob,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Profile scrape failed for ${profileId}:`, { error: message });

      return {
        success: false,
        message: `Scrape failed: ${message}`,
        profileId,
      };
    }
  }

  /**
   * @deprecated Use scrapeProfile() instead. This method now calls scrapeProfile.
   */
  async takeScreenShotAndUploadToS3(
    profileId: string,
    status: string = 'ally',
    _options: Record<string, unknown> = {}
  ): Promise<{ success: boolean; message: string; data?: unknown }> {
    logger.warn('takeScreenShotAndUploadToS3 is deprecated. Use scrapeProfile().');
    const result = await this.scrapeProfile(profileId, status);
    return {
      success: result.success,
      message: result.message,
      data: result.scrapeJob ? { jobId: result.jobId } : undefined,
    };
  }
}

export default LinkedInContactService;
