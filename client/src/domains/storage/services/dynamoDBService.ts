import axios, { type AxiosInstance, type AxiosError } from 'axios';
import { logger } from '#utils/logger.js';

const API_BASE_URL = process.env.API_GATEWAY_BASE_URL;
const DAILY_SCRAPE_CAP = 200;

interface MessageObject {
  content: string;
  timestamp: string;
  sender: string;
}

interface ImportCheckpoint {
  batchIndex: number;
  lastProfileId: string;
  connectionType: string;
  processedCount: number;
  totalCount: number;
  [key: string]: unknown;
}

class DynamoDBService {
  private authToken: string | null;
  private apiClient: AxiosInstance;

  constructor() {
    this.authToken = null;
    // Ensure trailing slash so relative endpoint paths join correctly (preserve stage path)
    const normalizedBaseUrl = API_BASE_URL
      ? API_BASE_URL.endsWith('/')
        ? API_BASE_URL
        : `${API_BASE_URL}/`
      : API_BASE_URL;

    this.apiClient = axios.create({
      baseURL: normalizedBaseUrl,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Internal POST helper with unified headers and error handling
   */
  // Returns parsed JSON from the API (shape varies per endpoint)
  private async _post(
    path: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.apiClient.post(path, body, { headers: this.getHeaders() });
      return response?.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Internal GET helper with unified headers and error handling
   */
  // Returns parsed JSON from the API (shape varies per endpoint)
  private async _get(
    path: string,
    params: Record<string, string> = {}
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.apiClient.get(path, {
        headers: this.getHeaders(),
        params,
      });
      return response?.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Set the authorization token for API requests
   */
  setAuthToken(token: string): void {
    this.authToken = token;
  }

  /**
   * Get headers for API requests
   */
  getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    return headers;
  }

  /**
   * Check if a profile exists and has been updated in the past month.
   * Returns true if profile doesn't exist or hasn't been updated in last month.
   */
  async getProfileDetails(profileId: string): Promise<boolean> {
    try {
      const data = await this._get('dynamodb', {
        profileId: profileId,
      });
      if (!data || !data.profile) return true;
      const profile = data.profile as Record<string, unknown>;
      const { updatedAt, evaluated } = profile;
      const isStale = this._isStale(updatedAt as string | undefined);
      if (typeof evaluated === 'boolean') return evaluated === false ? true : isStale;
      return isStale;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.info(`getProfileDetails fallback: ${errMsg}`);
      return true;
    }
  }

  private _isStale(updatedAt: string | undefined): boolean {
    if (!updatedAt) return true;
    const oneMonthAgo = new Date();
    oneMonthAgo.setDate(oneMonthAgo.getDate() - 30);
    return new Date(updatedAt) < oneMonthAgo;
  }

  /**
   * Create a "bad contact" profile and its edges with processed status
   */
  async createBadContactProfile(profileId: string): Promise<unknown> {
    return await this._post('dynamodb', {
      operation: 'create',
      profileId: profileId,
      updates: {
        evaluated: true,
        addedAt: new Date().toISOString(),
        processedAt: new Date().toISOString(),
      },
    });
  }

  /**
   * Mark a profile as bad contact (wrapper around createBadContactProfile)
   */
  async markBadContact(profileId: string): Promise<boolean> {
    if (!profileId) throw new Error('profileId is required');
    try {
      await this.createBadContactProfile(profileId);
      logger?.info?.(`Marked bad contact profile: ${profileId}`);
      return true;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger?.error?.(`Failed to mark bad contact for ${profileId}: ${errMsg}`);
      throw error;
    }
  }

  /**
   * Create or update profile metadata record.
   */
  async createProfileMetadata(
    profileId: string,
    metadata: Record<string, string | undefined> = {}
  ): Promise<unknown> {
    return await this._post('dynamodb', {
      operation: 'create',
      profileId,
      updates: {
        evaluated: false,
        addedAt: new Date().toISOString(),
        ...metadata,
      },
    });
  }

  /**
   * Update only the profile picture URL on an existing profile metadata record.
   */
  async updateProfilePictureUrl(profileId: string, pictureUrl: string): Promise<unknown> {
    return await this._post('dynamodb', {
      operation: 'update_profile_picture',
      profileId,
      profilePictureUrl: pictureUrl,
    });
  }

  /**
   * Public: Single entrypoint to upsert edge status (create if missing, update otherwise)
   */
  async upsertEdgeStatus(
    profileId: string,
    status: string,
    extraUpdates: Record<string, unknown> = {}
  ): Promise<unknown> {
    const now = new Date().toISOString();
    return await this._post('edges', {
      operation: 'upsert_status',
      profileId,
      updates: { status, ...extraUpdates, updatedAt: now },
    });
  }

  /**
   * Replace the full messages list on an edge (used after scraping a conversation).
   */
  async updateMessages(profileId: string, messages: MessageObject[]): Promise<unknown> {
    return await this._post('edges', {
      operation: 'update_messages',
      profileId,
      updates: { messages },
    });
  }

  /**
   * Check if an edge relationship exists between user and connection profile.
   * The user ID is extracted from the JWT token in the Lambda function.
   */
  async checkEdgeExists(connectionProfileId: string): Promise<boolean> {
    try {
      const data = await this._post('edges', {
        operation: 'check_exists',
        profileId: connectionProfileId,
      });
      const result = data?.result as Record<string, unknown> | undefined;
      const exists = !!result?.exists;
      logger.info(`Edge existence for ${connectionProfileId}: ${exists}`);
      return exists;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn(`checkEdgeExists failed for ${connectionProfileId}: ${errMsg}`);
      return false;
    }
  }

  /**
   * Get daily scrape count for today (UTC).
   */
  async getDailyScrapeCount(): Promise<number> {
    const today = new Date().toISOString().split('T')[0];
    try {
      const data = await this._get('dynamodb', {
        operation: 'get_daily_scrape_count',
        date: today!,
      });
      return (data?.count as number) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Increment the daily scrape counter by 1.
   */
  async incrementDailyScrapeCount(): Promise<unknown> {
    const today = new Date().toISOString().split('T')[0];
    return await this._post('dynamodb', {
      operation: 'increment_daily_scrape_count',
      date: today!,
    });
  }

  /**
   * Check if daily scrape cap has been reached.
   */
  async canScrapeToday(dailyCap = DAILY_SCRAPE_CAP): Promise<boolean> {
    const count = await this.getDailyScrapeCount();
    return count < dailyCap;
  }

  /**
   * Save an import checkpoint for bulk import resume.
   */
  async saveImportCheckpoint(checkpoint: ImportCheckpoint): Promise<unknown> {
    return await this._post('dynamodb', {
      operation: 'save_import_checkpoint',
      checkpoint,
    });
  }

  /**
   * Get the current import checkpoint, or null if none exists.
   */
  async getImportCheckpoint(): Promise<ImportCheckpoint | null> {
    try {
      const data = await this._get('dynamodb', {
        operation: 'get_import_checkpoint',
      });
      return (data?.checkpoint as ImportCheckpoint) || null;
    } catch {
      return null;
    }
  }

  /**
   * Clear the import checkpoint after completion.
   */
  async clearImportCheckpoint(): Promise<unknown> {
    return await this._post('dynamodb', {
      operation: 'clear_import_checkpoint',
    });
  }

  /**
   * Handle API errors consistently
   */
  handleError(error: unknown): Error {
    const axiosErr = error as AxiosError<{ error?: string }>;
    if (axiosErr.response) {
      // API responded with error status
      const message = axiosErr.response.data?.error || axiosErr.response.statusText;
      const statusCode = axiosErr.response.status;

      if (statusCode === 401) {
        return new Error('Authentication required. Please log in again.');
      } else if (statusCode === 403) {
        return new Error('Access denied. Check your permissions.');
      } else if (statusCode === 404) {
        return new Error('Resource not found.');
      } else if (statusCode >= 500) {
        return new Error('Server error. Please try again later.');
      }

      return new Error(`API Error (${statusCode}): ${message}`);
    } else if (axiosErr.request) {
      // Network error
      return new Error('Network error. Please check your connection.');
    } else {
      // Other error
      const errMsg = error instanceof Error ? error.message : 'An unexpected error occurred.';
      return new Error(errMsg);
    }
  }
}

// Export singleton instance
export default DynamoDBService;
