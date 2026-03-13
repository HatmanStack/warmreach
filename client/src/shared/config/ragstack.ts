/**
 * RAGStack configuration module
 *
 * Provides configuration for connecting to RAGStack-Lambda's GraphQL API
 * for knowledge base operations.
 */

export interface RagstackRetryConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
}

export interface RagstackConfig {
  endpoint: string;
  apiKey: string;
  retry: RagstackRetryConfig;
  isConfigured: () => boolean;
}

/**
 * RAGStack configuration with environment variable overrides
 */
export const ragstackConfig: RagstackConfig = {
  endpoint: process.env.RAGSTACK_GRAPHQL_ENDPOINT || '',
  apiKey: process.env.RAGSTACK_API_KEY || '',

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
