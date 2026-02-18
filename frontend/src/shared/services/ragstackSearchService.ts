/**
 * RAGStack Search Service
 *
 * Provides semantic search functionality for LinkedIn profiles
 * via the RAGStack proxy Lambda.
 */
import axios, { type AxiosInstance, type AxiosError } from 'axios';
import { CognitoAuthService } from '@/features/auth';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('RAGStackSearchService');

/**
 * Custom error class for search-related errors
 */
export class SearchError extends Error {
  status?: number;
  code?: string;
  retryable: boolean;
  declare cause?: Error;

  constructor(message: string, options?: { status?: number; code?: string; cause?: Error }) {
    super(message);
    this.name = 'SearchError';
    this.status = options?.status;
    this.code = options?.code;
    if (options?.cause) {
      this.cause = options.cause;
    }
    this.retryable = this.isRetryable();
  }

  private isRetryable(): boolean {
    // Network errors and server errors are retryable
    if (!this.status) return true;
    if (this.status >= 500) return true;
    if (this.status === 429) return true;
    return false;
  }
}

/**
 * Individual search result from RAGStack
 */
export interface SearchResult {
  /** Profile ID extracted from source field */
  profileId: string;
  /** Relevance score (0-1) */
  score: number;
  /** Text snippet from matched content */
  snippet: string;
}

/**
 * Search response structure
 */
export interface SearchResponse {
  /** Array of matching profiles */
  results: SearchResult[];
  /** Total number of results found */
  totalResults: number;
}

/**
 * RAGStack raw result format
 */
interface RAGStackResult {
  source: string;
  score: number;
  content: string;
}

/**
 * RAGStack Search Service class
 */
class RAGStackSearchService {
  private apiClient: AxiosInstance;
  private readonly timeout = 30000; // 30 second timeout for search operations

  constructor() {
    const apiBaseUrl = import.meta.env.VITE_API_GATEWAY_URL || '';

    // Normalize base URL to ensure trailing slash
    const normalizedBaseUrl = apiBaseUrl
      ? apiBaseUrl.endsWith('/')
        ? apiBaseUrl
        : `${apiBaseUrl}/`
      : undefined;

    this.apiClient = axios.create({
      baseURL: normalizedBaseUrl,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add request interceptor for authentication
    this.apiClient.interceptors.request.use(
      async (config) => {
        const token = await this.getAuthToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );
  }

  /**
   * Get JWT token from Cognito service
   */
  private async getAuthToken(): Promise<string | null> {
    try {
      return await CognitoAuthService.getCurrentUserToken();
    } catch (error) {
      logger.warn('Error getting auth token', { error });
      return null;
    }
  }

  /**
   * Extract profile ID from RAGStack source field
   * Source format: "profile_<id>" or just the raw ID
   */
  private extractProfileId(source: string): string {
    if (source.startsWith('profile_')) {
      return source.substring(8); // Remove "profile_" prefix
    }
    return source;
  }

  /**
   * Transform RAGStack results to SearchResult format
   */
  private transformResults(results: RAGStackResult[]): SearchResult[] {
    return results.map((result) => ({
      profileId: this.extractProfileId(result.source),
      score: result.score,
      snippet: result.content || '',
    }));
  }

  /**
   * Search profiles using semantic search
   *
   * @param query - Search query string
   * @param maxResults - Maximum number of results (default 100)
   * @returns Promise<SearchResponse>
   * @throws SearchError on failure
   */
  async search(query: string, maxResults = 100): Promise<SearchResponse> {
    try {
      logger.debug('Executing profile search', { queryLength: query.length, maxResults });

      const response = await this.apiClient.post(
        'ragstack',
        {
          operation: 'search',
          query,
          maxResults,
        },
        {
          timeout: this.timeout,
        }
      );

      // Handle Lambda proxy response format
      const responseData = response.data;
      let parsedBody: { results: RAGStackResult[]; totalResults: number };

      if (responseData && typeof responseData === 'object' && 'statusCode' in responseData) {
        // Lambda proxy response format
        if (responseData.statusCode !== 200) {
          const errorBody =
            typeof responseData.body === 'string'
              ? JSON.parse(responseData.body)
              : responseData.body;
          throw new SearchError(
            errorBody?.error || `Search failed with status ${responseData.statusCode}`,
            { status: responseData.statusCode }
          );
        }

        parsedBody =
          typeof responseData.body === 'string' ? JSON.parse(responseData.body) : responseData.body;
      } else {
        // Direct API Gateway response
        parsedBody = responseData;
      }

      const results = this.transformResults(parsedBody.results || []);

      logger.debug('Search completed', {
        resultCount: results.length,
        totalResults: parsedBody.totalResults,
      });

      return {
        results,
        totalResults: parsedBody.totalResults || results.length,
      };
    } catch (error) {
      if (error instanceof SearchError) {
        throw error;
      }

      const axiosError = error as AxiosError;
      const message = axiosError.message || 'Profile search failed';
      const status = axiosError.response?.status;

      logger.error('Search failed', {
        error: message,
        status,
        queryLength: query.length,
      });

      throw new SearchError(message, {
        status,
        code: axiosError.code,
        cause: error as Error,
      });
    }
  }
}

// Singleton instance
const ragstackSearchService = new RAGStackSearchService();

/**
 * Search profiles using semantic search
 *
 * @param query - Search query string
 * @param maxResults - Maximum number of results (default 100)
 * @returns Promise<SearchResponse>
 * @throws SearchError on failure
 */
export async function searchProfiles(query: string, maxResults = 100): Promise<SearchResponse> {
  return ragstackSearchService.search(query, maxResults);
}
