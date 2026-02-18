/**
 * RAGStack GraphQL Types
 *
 * Type definitions for RAGStack-Lambda's GraphQL API operations,
 * specifically for web scraping and knowledge base features.
 */

// ============================================================================
// Scrape Input Types
// ============================================================================

/**
 * Input for starting a web scrape job
 */
export interface StartScrapeInput {
  /** URL to start scraping from */
  url: string;
  /** Maximum number of pages to scrape (default: 10) */
  maxPages?: number;
  /** Maximum depth to follow links (default: 2) */
  maxDepth?: number;
  /** Scope of URLs to include in scrape */
  scope?: 'SUBPAGES' | 'HOSTNAME' | 'DOMAIN';
  /** URL patterns to include (glob patterns) */
  includePatterns?: string[];
  /** URL patterns to exclude (glob patterns) */
  excludePatterns?: string[];
  /** Scraping mode: AUTO (detect), FAST (HTTP only), FULL (headless browser) */
  scrapeMode?: 'AUTO' | 'FAST' | 'FULL';
  /** Cookies to pass for authenticated scraping (format: "name=value; name2=value2") */
  cookies?: string;
  /** Force re-scrape even if content unchanged */
  forceRescrape?: boolean;
}

// ============================================================================
// Scrape Job Types
// ============================================================================

/**
 * Status of a scrape job
 */
export type ScrapeJobStatus =
  | 'PENDING'
  | 'DISCOVERING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/**
 * Scrape job details
 */
export interface ScrapeJob {
  /** Unique job identifier */
  jobId: string;
  /** Base URL that was scraped */
  baseUrl: string;
  /** Current job status */
  status: ScrapeJobStatus;
  /** Total URLs discovered */
  totalUrls?: number;
  /** Number of URLs successfully processed */
  processedCount?: number;
  /** Number of URLs that failed */
  failedCount?: number;
}

// ============================================================================
// GraphQL Response Types
// ============================================================================

/**
 * Response from startScrape mutation
 */
export interface StartScrapeResponse {
  startScrape: ScrapeJob;
}

/**
 * Response from getScrapeJob query
 */
export interface GetScrapeJobResponse {
  getScrapeJob: {
    job: ScrapeJob;
  };
}

// ============================================================================
// Search Types (for future use)
// ============================================================================

/**
 * A single search result from the knowledge base
 */
export interface SearchResult {
  /** Matching content text */
  content: string;
  /** Source URL or document ID */
  source: string;
  /** Relevance score (0-1) */
  score: number;
}

/**
 * Response from searchKnowledgeBase query
 */
export interface SearchKnowledgeBaseResponse {
  searchKnowledgeBase: {
    results: SearchResult[];
  };
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Base error class for RAGStack operations
 */
export class RagstackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RagstackError';
  }
}

/**
 * HTTP-level error from RAGStack API
 */
export class RagstackHttpError extends RagstackError {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(statusCode: number, responseBody: string) {
    super(`HTTP ${statusCode}: ${responseBody}`);
    this.name = 'RagstackHttpError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }

  /**
   * Check if this error is retriable (5xx or rate limit)
   */
  isRetriable(): boolean {
    return this.statusCode >= 500 || this.statusCode === 429;
  }
}

/**
 * GraphQL-level error from RAGStack API
 */
export class RagstackGraphQLError extends RagstackError {
  readonly errors: Array<{ message: string; path?: string[] }>;

  constructor(errors: Array<{ message: string; path?: string[] }>) {
    super(`GraphQL errors: ${errors.map((e) => e.message).join(', ')}`);
    this.name = 'RagstackGraphQLError';
    this.errors = errors;
  }
}

/**
 * Timeout error for polling operations
 */
export class RagstackTimeoutError extends RagstackError {
  readonly jobId: string;
  readonly elapsedMs: number;

  constructor(jobId: string, elapsedMs: number) {
    super(`Timeout waiting for job ${jobId} after ${elapsedMs}ms`);
    this.name = 'RagstackTimeoutError';
    this.jobId = jobId;
    this.elapsedMs = elapsedMs;
  }
}
