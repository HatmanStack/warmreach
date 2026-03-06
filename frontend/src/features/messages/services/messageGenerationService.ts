import { CognitoAuthService } from '@/features/auth';
import { API_CONFIG } from '@/config/appConfig';
import type { Message, UserProfile } from '@/shared/types/index';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('MessageGenerationService');

// =============================================================================
// INTERFACES
// =============================================================================

/**
 * Request payload for message generation API
 */
export interface MessageGenerationRequest {
  /** ID of the connection to generate message for */
  connectionId: string;

  /** Connection profile data for personalization */
  connectionProfile: {
    firstName: string;
    lastName: string;
    position: string;
    company: string;
    headline?: string;
    tags?: string[];
  };

  /** Conversation topic entered by user */
  conversationTopic: string;

  /** Previous message history with this connection */
  messageHistory?: Message[];

  /** User's profile information for context */
  userProfile?: UserProfile;
}

/**
 * Response from message generation API
 */
interface MessageGenerationResponse {
  /** AI-generated message content */
  generatedMessage: string;

  /** Confidence score for the generated message (0-1) */
  confidence: number;

  /** Optional reasoning or explanation for the message */
  reasoning?: string;
}

/**
 * Custom error class for message generation API errors
 */
export class MessageGenerationError extends Error {
  status?: number;
  code?: string;

  constructor({ message, status, code }: { message: string; status?: number; code?: string }) {
    super(message);
    this.name = 'MessageGenerationError';
    this.status = status;
    this.code = code;
  }
}

// =============================================================================
// SERVICE CONFIGURATION
// =============================================================================

const MESSAGE_GENERATION_CONFIG = {
  BASE_URL: import.meta.env.VITE_API_GATEWAY_URL || API_CONFIG.BASE_URL,
  ENDPOINT: API_CONFIG.ENDPOINTS.MESSAGE_GENERATION,
  TIMEOUT: 30000, // 30 seconds for AI generation
  MOCK_MODE: import.meta.env.VITE_MOCK_MODE === 'true' || process.env.NODE_ENV === 'development', // Use mock responses in development
} as const;

// =============================================================================
// MESSAGE GENERATION SERVICE
// =============================================================================

/**
 * Service for handling AI-powered message generation
 *
 * This service integrates with the backend Lambda function to generate
 * personalized messages based on connection data and conversation topics.
 */
class MessageGenerationService {
  private baseURL: string;
  private timeout: number;

  constructor() {
    this.baseURL = MESSAGE_GENERATION_CONFIG.BASE_URL;
    this.timeout = MESSAGE_GENERATION_CONFIG.TIMEOUT;
  }

  /**
   * Get JWT token from Cognito for API authentication
   */
  private async getAuthToken(): Promise<string | null> {
    try {
      const token = await CognitoAuthService.getCurrentUserToken();
      if (token) {
        // Store in session storage for future use
        sessionStorage.setItem('jwt_token', token);
        return token;
      }
      return null;
    } catch (error) {
      logger.error('Error getting auth token', { error });
      return null;
    }
  }

  /**
   * Make authenticated HTTP request to the API
   */
  private async makeRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      // Get JWT token for authentication
      const token = await this.getAuthToken();

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string>),
      };

      // Add Authorization header if token is available
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(`${this.baseURL}${endpoint}`, {
        ...options,
        signal: controller.signal,
        headers,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new MessageGenerationError({
          message: errorData.message || `HTTP error! status: ${response.status}`,
          status: response.status,
          code: errorData.code,
        });
      }

      const data = await response.json();
      return data;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof MessageGenerationError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new MessageGenerationError({
            message: 'Request timeout - message generation is taking too long',
            code: 'TIMEOUT',
          });
        }
        throw new MessageGenerationError({
          message: error.message || 'An unexpected error occurred',
          code: 'NETWORK_ERROR',
        });
      }

      throw new MessageGenerationError({
        message: 'An unexpected error occurred',
        code: 'UNKNOWN_ERROR',
      });
    }
  }

  /**
   * Generate a personalized message for a specific connection
   *
   * @param request - Message generation request parameters
   * @returns Promise resolving to generated message content
   * @throws MessageGenerationError for API or network errors
   */
  async generateMessage(request: MessageGenerationRequest): Promise<string> {
    try {
      // Validate required fields
      this.validateRequest(request);

      // Use mock response in development mode
      if (MESSAGE_GENERATION_CONFIG.MOCK_MODE) {
        return this.generateMockResponse(request);
      }

      // Prepare the API request payload
      const payload = this.formatRequestPayload(request);

      // Make the API call
      const response = await this.makeRequest<MessageGenerationResponse>(
        MESSAGE_GENERATION_CONFIG.ENDPOINT,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        }
      );

      // Validate and return the generated message
      if (!response.generatedMessage) {
        throw new MessageGenerationError({
          message: 'Invalid response: missing generated message',
          code: 'INVALID_RESPONSE',
        });
      }

      return response.generatedMessage;
    } catch (error) {
      // Re-throw MessageGenerationError instances
      if (error instanceof MessageGenerationError) {
        throw error;
      }

      // Wrap other errors
      throw new MessageGenerationError({
        message: error instanceof Error ? error.message : 'Failed to generate message',
        code: 'GENERATION_FAILED',
      });
    }
  }

  /**
   * Generate messages for multiple connections in batch
   *
   * @param requests - Array of message generation requests
   * @returns Promise resolving to Map of connectionId -> generated message
   */
  async generateBatchMessages(requests: MessageGenerationRequest[]): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    const errors = new Map<string, MessageGenerationError>();

    // Process requests sequentially to avoid overwhelming the API
    for (const request of requests) {
      try {
        const message = await this.generateMessage(request);
        results.set(request.connectionId, message);
      } catch (error) {
        const generationError =
          error instanceof MessageGenerationError
            ? error
            : new MessageGenerationError({
                message: error instanceof Error ? error.message : 'Unknown error',
                code: 'BATCH_GENERATION_FAILED',
              });

        errors.set(request.connectionId, generationError);
      }
    }

    // If all requests failed, throw an error
    if (results.size === 0 && errors.size > 0) {
      const firstError = Array.from(errors.values())[0];
      throw new MessageGenerationError({
        message: `Batch generation failed: ${firstError.message}`,
        code: 'BATCH_GENERATION_FAILED',
      });
    }

    return results;
  }

  /**
   * Generate mock response for development and testing
   */
  private async generateMockResponse(request: MessageGenerationRequest): Promise<string> {
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 2000));

    const { connectionProfile, conversationTopic } = request;
    const { firstName, position, company } = connectionProfile;

    // Generate realistic mock message based on the conversation topic
    const mockMessages = [
      `Hi ${firstName}, I noticed your work at ${company} as ${position}. I'd love to discuss ${conversationTopic} with you - it's something I'm passionate about and I think we could have a great conversation about it.`,
      `Hello ${firstName}, Your experience at ${company} caught my attention. I'm really interested in ${conversationTopic} and would appreciate your insights on this topic. Would you be open to connecting?`,
      `Hi ${firstName}, I came across your profile and was impressed by your role as ${position} at ${company}. I'm currently exploring ${conversationTopic} and would love to hear your perspective on it.`,
      `Hello ${firstName}, I hope you're doing well! I noticed we might have some common interests around ${conversationTopic}. Given your background at ${company}, I'd love to connect and learn from your experience.`,
    ];

    // Randomly select a mock message
    const selectedMessage = mockMessages[Math.floor(Math.random() * mockMessages.length)];

    // Occasionally simulate an error for testing
    if (Math.random() < 0.1) {
      // 10% chance of error
      throw new MessageGenerationError({
        message: 'Mock API error for testing',
        status: 500,
        code: 'MOCK_ERROR',
      });
    }

    return selectedMessage;
  }

  /**
   * Validate the message generation request
   */
  private validateRequest(request: MessageGenerationRequest): void {
    if (!request.connectionId) {
      throw new MessageGenerationError({
        message: 'Connection ID is required',
        code: 'INVALID_REQUEST',
      });
    }

    if (!request.conversationTopic?.trim()) {
      throw new MessageGenerationError({
        message: 'Conversation topic is required',
        code: 'INVALID_REQUEST',
      });
    }

    if (!request.connectionProfile) {
      throw new MessageGenerationError({
        message: 'Connection profile is required',
        code: 'INVALID_REQUEST',
      });
    }

    const { firstName, lastName, position, company } = request.connectionProfile;
    if (!firstName || !lastName || !position || !company) {
      throw new MessageGenerationError({
        message: 'Connection profile must include firstName, lastName, position, and company',
        code: 'INVALID_REQUEST',
      });
    }
  }

  /**
   * Format the request payload for the API
   */
  private formatRequestPayload(request: MessageGenerationRequest): Record<string, unknown> {
    return {
      operation: 'generate_message',
      connectionId: request.connectionId,
      connectionProfile: {
        firstName: request.connectionProfile.firstName,
        lastName: request.connectionProfile.lastName,
        position: request.connectionProfile.position,
        company: request.connectionProfile.company,
        headline: request.connectionProfile.headline,
        tags: request.connectionProfile.tags || [],
      },
      conversationTopic: request.conversationTopic.trim(),
      messageHistory: request.messageHistory || [],
      userProfile: request.userProfile
        ? {
            firstName: request.userProfile.first_name,
            lastName: request.userProfile.last_name,
            headline: request.userProfile.headline,
            company: request.userProfile.company,
            position: request.userProfile.current_position,
            industry: request.userProfile.industry,
            interests: request.userProfile.interests || [],
          }
        : undefined,
    };
  }

  // Removed unused handleApiError to reduce complexity
}

// =============================================================================
// EXPORTS
// =============================================================================

// Create singleton instance
export const messageGenerationService = new MessageGenerationService();

// Interfaces are already exported above with their declarations
