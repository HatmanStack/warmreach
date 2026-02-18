/**
 * RAGStack Scrape Service
 *
 * GraphQL client for RAGStack-Lambda web scraping operations.
 * Handles starting scrape jobs, polling for completion, and error handling.
 */

import type { RagstackConfig } from '../../../shared/config/ragstack.js';
import { ragstackConfig as defaultConfig } from '../../../shared/config/ragstack.js';
import {
  StartScrapeInput,
  StartScrapeResponse,
  GetScrapeJobResponse,
  ScrapeJob,
  ScrapeJobStatus,
  RagstackHttpError,
  RagstackGraphQLError,
  RagstackTimeoutError,
} from '../types/ragstack.js';

/**
 * Options for waitForCompletion polling
 */
export interface WaitOptions {
  /** Polling interval in milliseconds (default: 2000) */
  pollInterval?: number;
  /** Timeout in milliseconds (default: 300000 = 5 min) */
  timeout?: number;
}

/**
 * Service for interacting with RAGStack scraping API
 */
export class RagstackScrapeService {
  private readonly config: RagstackConfig;

  // GraphQL queries and mutations
  private static readonly START_SCRAPE_MUTATION = `
    mutation StartScrape($input: StartScrapeInput!) {
      startScrape(input: $input) {
        jobId
        baseUrl
        status
      }
    }
  `;

  private static readonly GET_SCRAPE_JOB_QUERY = `
    query GetScrapeJob($jobId: ID!) {
      getScrapeJob(jobId: $jobId) {
        job {
          jobId
          baseUrl
          status
          totalUrls
          processedCount
          failedCount
        }
      }
    }
  `;

  /**
   * Terminal statuses that indicate a scrape job is complete
   */
  private static readonly TERMINAL_STATUSES: ScrapeJobStatus[] = [
    'COMPLETED',
    'FAILED',
    'CANCELLED',
  ];

  constructor(config?: Partial<RagstackConfig> & { endpoint: string; apiKey: string }) {
    this.config = {
      ...defaultConfig,
      ...config,
    } as RagstackConfig;

    if (!this.config.endpoint) {
      throw new Error('RAGStack endpoint is required');
    }
    if (!this.config.apiKey) {
      throw new Error('RAGStack apiKey is required');
    }
  }

  /**
   * Start a scrape job for a LinkedIn profile
   *
   * @param profileId - LinkedIn profile ID (e.g., "john-doe")
   * @param cookies - Serialized cookies for authentication
   * @returns The started scrape job
   */
  async startScrape(profileId: string, cookies: string): Promise<ScrapeJob> {
    const input: StartScrapeInput = {
      url: `https://www.linkedin.com/in/${profileId}/`,
      maxPages: this.config.scrape.maxPages,
      maxDepth: this.config.scrape.maxDepth,
      scope: this.config.scrape.scope,
      includePatterns: [`/in/${profileId}/*`],
      scrapeMode: this.config.scrape.scrapeMode,
      cookies,
      forceRescrape: false,
    };

    const response = await this.executeWithRetry<StartScrapeResponse>(
      RagstackScrapeService.START_SCRAPE_MUTATION,
      { input }
    );

    return response.startScrape;
  }

  /**
   * Get the current status of a scrape job
   *
   * @param jobId - The job ID to query
   * @returns The scrape job status
   */
  async getScrapeJob(jobId: string): Promise<ScrapeJob> {
    const response = await this.executeWithRetry<GetScrapeJobResponse>(
      RagstackScrapeService.GET_SCRAPE_JOB_QUERY,
      { jobId }
    );

    return response.getScrapeJob.job;
  }

  /**
   * Wait for a scrape job to complete
   *
   * @param jobId - The job ID to poll
   * @param options - Polling options
   * @returns The completed scrape job
   * @throws RagstackTimeoutError if timeout exceeded
   */
  async waitForCompletion(jobId: string, options?: WaitOptions): Promise<ScrapeJob> {
    const pollInterval = options?.pollInterval ?? 2000;
    const timeout = options?.timeout ?? 300000; // 5 minutes default

    const startTime = Date.now();

    while (true) {
      const job = await this.getScrapeJob(jobId);

      if (RagstackScrapeService.TERMINAL_STATUSES.includes(job.status)) {
        return job;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= timeout) {
        throw new RagstackTimeoutError(jobId, elapsed);
      }

      await this.sleep(pollInterval);
    }
  }

  /**
   * Execute a GraphQL request with retry logic
   */
  private async executeWithRetry<T>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const { maxAttempts, baseDelay, maxDelay } = this.config.retry;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.executeGraphQL<T>(query, variables);
      } catch (error) {
        lastError = error as Error;

        // Don't retry non-retriable errors
        if (error instanceof RagstackHttpError && !error.isRetriable()) {
          throw error;
        }

        // Don't retry GraphQL errors (usually bad input)
        if (error instanceof RagstackGraphQLError) {
          throw error;
        }

        // If we've exhausted retries, throw
        if (attempt >= maxAttempts) {
          throw error;
        }

        // Calculate delay with exponential backoff and jitter
        const delay = Math.min(
          baseDelay * Math.pow(2, attempt - 1) + Math.random() * 100,
          maxDelay
        );

        await this.sleep(delay);
      }
    }

    // Should never reach here, but TypeScript needs this
    throw lastError;
  }

  /**
   * Execute a GraphQL request
   */
  private async executeGraphQL<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new RagstackHttpError(response.status, body);
    }

    const result = await response.json();

    if (result.errors) {
      throw new RagstackGraphQLError(result.errors);
    }

    return result.data;
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default RagstackScrapeService;
