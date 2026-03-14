import { logger } from '#utils/logger.js';

interface HttpClient {
  get: (url: string, config: Record<string, unknown>) => Promise<{ data: unknown }>;
  post: (
    url: string,
    data: Record<string, unknown>,
    config: Record<string, unknown>
  ) => Promise<{ data: unknown }>;
}

interface RagstackProxyServiceOptions {
  apiBaseUrl?: string;
  httpClient: HttpClient;
}

interface IngestParams {
  profileId: string;
  markdownContent: string;
  metadata: Record<string, unknown>;
  jwtToken?: string;
}

interface FetchProfileParams {
  profileId: string;
  jwtToken?: string;
}

/**
 * Service for communicating with the RAGStack backend proxy endpoint.
 * Handles ingestion and profile fetching via HTTP. The HTTP client is
 * injected for testability.
 */
export class RagstackProxyService {
  private _apiBaseUrl: string;
  private _httpClient: HttpClient;

  constructor(options: RagstackProxyServiceOptions) {
    const url = options.apiBaseUrl || '';
    this._apiBaseUrl = url && !url.endsWith('/') ? `${url}/` : url;
    this._httpClient = options.httpClient;
  }

  /**
   * Check if the service has a configured API base URL.
   */
  isConfigured(): boolean {
    return Boolean(this._apiBaseUrl);
  }

  /**
   * Ingest a profile into RAGStack via the backend proxy.
   */
  async ingest(params: IngestParams): Promise<{ documentId?: string; success?: boolean } | null> {
    const { profileId, markdownContent, metadata, jwtToken } = params;

    try {
      const response = await this._httpClient.post(
        `${this._apiBaseUrl}ragstack`,
        {
          operation: 'ingest',
          profileId,
          markdownContent,
          metadata,
        },
        {
          headers: this._buildHeaders(jwtToken),
        }
      );

      return response.data as { documentId?: string } | null;
    } catch (error) {
      logger.debug('Failed to ingest profile', {
        profileId,
        error: (error as Error).message,
      });
      return { success: false };
    }
  }

  /**
   * Fetch a profile from the backend profiles endpoint.
   */
  async fetchProfile(
    params: FetchProfileParams
  ): Promise<{ profile?: Record<string, unknown> } | null> {
    const { profileId, jwtToken } = params;

    try {
      const response = await this._httpClient.get(`${this._apiBaseUrl}profiles`, {
        params: { profileId },
        headers: this._buildHeaders(jwtToken),
      });

      return response.data as { profile?: Record<string, unknown> } | null;
    } catch (error) {
      logger.debug('Failed to fetch profile', {
        profileId,
        error: (error as Error).message,
      });
      return null;
    }
  }

  private _buildHeaders(jwtToken?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (jwtToken) {
      headers.Authorization = `Bearer ${jwtToken}`;
    }
    return headers;
  }
}
