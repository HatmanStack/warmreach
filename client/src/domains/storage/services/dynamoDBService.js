import axios from 'axios';
import { logger } from '#utils/logger.js';

const API_BASE_URL = process.env.API_GATEWAY_BASE_URL;

class DynamoDBService {
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
  async _post(path, body) {
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
  async _get(path, params = {}) {
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
   * @param {string} token - JWT token from Cognito
   */
  setAuthToken(token) {
    this.authToken = token;
  }

  /**
   * Get headers for API requests
   * @returns {Object} Headers object
   */
  getHeaders() {
    const headers = {
      'Content-Type': 'application/json',
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    return headers;
  }

  /**
   * Check if a profile exists and has been updated in the past month
   * @param {string} profileId - Profile ID to check
   * @returns {Promise<boolean>} true if profile doesn't exist or hasn't been updated in last month, false otherwise
   */
  async getProfileDetails(profileId) {
    try {
      const data = await this._get('dynamodb', {
        profileId: profileId,
      });
      if (!data || !data.profile) return true;
      const { updatedAt, evaluated } = data.profile;
      const isStale = this._isStale(updatedAt);
      if (typeof evaluated === 'boolean') return evaluated === false ? true : isStale;
      return isStale;
    } catch (error) {
      logger.info(`getProfileDetails fallback: ${error.message}`);
      return true;
    }
  }

  _isStale(updatedAt) {
    if (!updatedAt) return true;
    const oneMonthAgo = new Date();
    oneMonthAgo.setDate(oneMonthAgo.getDate() - 30);
    return new Date(updatedAt) < oneMonthAgo;
  }

  /**
   * Create a "bad contact" profile and its edges with processed status
   * @param {Object} profileData - Profile information
   * @param {Object} edgesData - Edge relationship data
   * @returns {Promise<Object>} Creation result
   */
  async createBadContactProfile(profileId) {
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
   * @param {string} profileId
   * @returns {Promise<boolean>}
   */
  async markBadContact(profileId) {
    if (!profileId) throw new Error('profileId is required');
    try {
      await this.createBadContactProfile(profileId);
      logger?.info?.(`Marked bad contact profile: ${profileId}`);
      return true;
    } catch (error) {
      logger?.error?.(`Failed to mark bad contact for ${profileId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create or update profile metadata record.
   * @param {string} profileId - Profile identifier
   * @param {Object} metadata - Profile metadata (name, headline, etc.)
   * @returns {Promise<Object>} Creation result
   */
  async createProfileMetadata(profileId, metadata = {}) {
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
   * @param {string} profileId - Profile identifier
   * @param {string} pictureUrl - LinkedIn CDN picture URL
   * @returns {Promise<Object>} Update result
   */
  async updateProfilePictureUrl(profileId, pictureUrl) {
    return await this._post('dynamodb', {
      operation: 'update_profile_picture',
      profileId,
      profilePictureUrl: pictureUrl,
    });
  }

  /**
   * Public: Single entrypoint to upsert edge status (create if missing, update otherwise)
   */
  async upsertEdgeStatus(profileId, status, extraUpdates = {}) {
    const now = new Date().toISOString();
    return await this._post('edges', {
      operation: 'upsert_status',
      profileId,
      updates: { status, ...extraUpdates, updatedAt: now },
    });
  }

  /**
   * Replace the full messages list on an edge (used after scraping a conversation).
   * @param {string} profileId - Connection profile ID
   * @param {Array} messages - Array of message objects {content, timestamp, sender}
   * @returns {Promise<Object>} Update result
   */
  async updateMessages(profileId, messages) {
    return await this._post('edges', {
      operation: 'update_messages',
      profileId,
      updates: { messages },
    });
  }

  /**
   * Check if an edge relationship exists between user and connection profile
   * The user ID is extracted from the JWT token in the Lambda function
   * @param {string} connectionProfileId - Connection profile ID to check
   * @returns {Promise<boolean>} true if edge exists, false otherwise
   */
  async checkEdgeExists(connectionProfileId) {
    try {
      const data = await this._post('edges', {
        operation: 'check_exists',
        profileId: connectionProfileId,
      });
      const exists = !!data?.result?.exists;
      logger.info(`Edge existence for ${connectionProfileId}: ${exists}`);
      return exists;
    } catch (error) {
      logger.warn(`checkEdgeExists failed for ${connectionProfileId}: ${error.message}`);
      return false;
    }
  }

  /**
   * Handle API errors consistently
   * @param {Error} error - The error object
   * @returns {Error} Formatted error
   */
  handleError(error) {
    if (error.response) {
      // API responded with error status
      const message = error.response.data?.error || error.response.statusText;
      const statusCode = error.response.status;

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
    } else if (error.request) {
      // Network error
      return new Error('Network error. Please check your connection.');
    } else {
      // Other error
      return new Error(error.message || 'An unexpected error occurred.');
    }
  }
}

// Export singleton instance
export default DynamoDBService;
