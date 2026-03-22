import { API_CONFIG } from '@/config/appConfig';
import { httpClient } from '@/shared/utils/httpClient';
import type { Message, Note, UserProfile } from '@/shared/types/index';

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

  /** User-recorded notes about this connection for personalization */
  connectionNotes?: Note[];
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
  ENDPOINT: API_CONFIG.ENDPOINTS.MESSAGE_GENERATION,
  MOCK_MODE: import.meta.env.VITE_MOCK_MODE === 'true',
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

      // Make the API call via httpClient
      const result = await httpClient.post<MessageGenerationResponse>(
        MESSAGE_GENERATION_CONFIG.ENDPOINT,
        payload
      );

      if (!result.success) {
        throw new MessageGenerationError({
          message: result.error?.message || 'Message generation failed',
          status: result.error?.status,
          code: result.error?.code,
        });
      }

      // Validate and return the generated message
      if (!result.data?.generatedMessage) {
        throw new MessageGenerationError({
          message: 'Invalid response: missing generated message',
          code: 'INVALID_RESPONSE',
        });
      }

      return result.data.generatedMessage;
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
   * @returns Promise resolving to object with successful results and any errors
   */
  async generateBatchMessages(
    requests: MessageGenerationRequest[]
  ): Promise<{ results: Map<string, string>; errors: Map<string, MessageGenerationError> }> {
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

    return { results, errors };
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
   * Generate icebreaker messages for a first-contact connection
   *
   * @param connectionProfile - Profile of the connection
   * @param connectionNotes - Optional notes about the connection
   * @param connectionId - Optional connection ID
   * @returns Promise resolving to array of icebreaker messages
   */
  async generateIcebreakers(
    connectionProfile: MessageGenerationRequest['connectionProfile'],
    connectionNotes?: string[],
    connectionId?: string
  ): Promise<{ icebreakers: string[] }> {
    const result = await httpClient.makeRequest<{ icebreakers: string[] }>(
      MESSAGE_GENERATION_CONFIG.ENDPOINT,
      'generate_message',
      {
        mode: 'icebreaker',
        connectionId: connectionId || 'unknown',
        connectionProfile: {
          firstName: connectionProfile.firstName,
          lastName: connectionProfile.lastName,
          position: connectionProfile.position,
          company: connectionProfile.company,
          headline: connectionProfile.headline,
          tags: connectionProfile.tags || [],
        },
        connectionNotes: connectionNotes || [],
      }
    );

    if (!result.success) {
      throw new MessageGenerationError({
        message: result.error?.message || 'Icebreaker generation failed',
        status: result.error?.status,
        code: result.error?.code,
      });
    }

    return result.data;
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
}

// =============================================================================
// EXPORTS
// =============================================================================

// Create singleton instance
export const messageGenerationService = new MessageGenerationService();

// Interfaces are already exported above with their declarations
