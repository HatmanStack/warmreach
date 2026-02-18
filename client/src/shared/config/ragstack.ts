/**
 * RAGStack configuration module
 *
 * Provides configuration for connecting to RAGStack-Lambda's GraphQL API
 * for web scraping and knowledge base operations.
 */

export type ScrapeMode = 'AUTO' | 'FAST' | 'FULL';
export type ScrapeScope = 'SUBPAGES' | 'HOSTNAME' | 'DOMAIN';

export interface RagstackScrapeConfig {
  maxPages: number;
  maxDepth: number;
  scrapeMode: ScrapeMode;
  scope: ScrapeScope;
}

export interface RagstackRetryConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
}

export interface RagstackConfig {
  endpoint: string;
  apiKey: string;
  scrape: RagstackScrapeConfig;
  retry: RagstackRetryConfig;
  isConfigured: () => boolean;
}

// Helper to safely parse integers with fallback
function safeParseInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}

// Helper to validate ScrapeMode
function validateScrapeMode(value: string | undefined): ScrapeMode {
  const validModes: ScrapeMode[] = ['AUTO', 'FAST', 'FULL'];
  if (value && validModes.includes(value as ScrapeMode)) {
    return value as ScrapeMode;
  }
  return 'FULL';
}

/**
 * RAGStack configuration with environment variable overrides
 */
export const ragstackConfig: RagstackConfig = {
  endpoint: process.env.RAGSTACK_GRAPHQL_ENDPOINT || '',
  apiKey: process.env.RAGSTACK_API_KEY || '',

  scrape: {
    maxPages: safeParseInt(process.env.RAGSTACK_SCRAPE_MAX_PAGES, 5),
    maxDepth: safeParseInt(process.env.RAGSTACK_SCRAPE_MAX_DEPTH, 1),
    scrapeMode: validateScrapeMode(process.env.RAGSTACK_SCRAPE_MODE),
    scope: 'SUBPAGES' as ScrapeScope,
  },

  retry: {
    maxAttempts: 3,
    baseDelay: 1000,
    maxDelay: 30000,
  },

  /**
   * Check if RAGStack is properly configured
   * @returns true if both endpoint and apiKey are set
   */
  isConfigured(): boolean {
    return Boolean(this.endpoint && this.apiKey);
  },
};

export default ragstackConfig;
