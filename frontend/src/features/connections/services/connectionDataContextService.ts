import type { Connection, Message } from '@/shared/types/index';
import type { UserProfile } from '@/types';
import type { MessageGenerationRequest } from '@/features/messages';

// =============================================================================
// INTERFACES
// =============================================================================

/**
 * Context data prepared for message generation
 */
interface MessageGenerationContext {
  /** Connection data formatted for API */
  connection: Connection;
  /** Conversation topic */
  topic: string;
  /** Formatted message history */
  messageHistory: Message[];
  /** User profile data */
  userProfile: UserProfile;
  /** Previously generated messages in this session */
  previousMessages: string[];
}

/**
 * Options for context preparation
 */
interface ContextPreparationOptions {
  /** Include message history in context */
  includeMessageHistory?: boolean;
  /** Maximum number of messages to include */
  maxMessageHistory?: number;
  /** Include user profile data */
  includeUserProfile?: boolean;
  /** Include connection tags */
  includeTags?: boolean;
  /** Previously generated messages to include for context */
  previousMessages?: string[];
}

// =============================================================================
// CONNECTION DATA CONTEXT SERVICE
// =============================================================================

/**
 * Service for preparing connection data context for message generation
 *
 * This service extracts and formats relevant connection data, message history,
 * user profile information, and conversation context for AI message generation.
 */
class ConnectionDataContextService {
  /**
   * Prepare complete context data for message generation
   *
   * @param connection - Connection to generate message for
   * @param conversationTopic - Topic for the conversation
   * @param userProfile - User's profile information
   * @param options - Context preparation options
   * @returns Prepared context data
   */
  prepareMessageGenerationContext(
    connection: Connection,
    conversationTopic: string,
    userProfile?: UserProfile,
    options: ContextPreparationOptions = {}
  ): MessageGenerationContext {
    const {
      includeMessageHistory = true,
      maxMessageHistory = 10,
      includeUserProfile = true,
      previousMessages = [],
    } = options;

    return {
      connection,
      topic: this.prepareConversationTopic(conversationTopic),
      messageHistory: includeMessageHistory
        ? this.prepareMessageHistory(connection, maxMessageHistory)
        : [],
      userProfile:
        includeUserProfile && userProfile
          ? this.prepareUserProfileData(userProfile)
          : ({} as UserProfile),
      previousMessages: [...previousMessages],
    };
  }

  /**
   * Extract relevant connection profile data for API calls
   *
   * @param connection - Connection object
   * @returns Formatted connection profile data
   */
  extractConnectionProfileData(connection: Connection): {
    firstName: string;
    lastName: string;
    position: string;
    company: string;
    headline?: string;
    tags?: string[];
  } {
    return {
      firstName: connection.first_name,
      lastName: connection.last_name,
      position: connection.position,
      company: connection.company,
      headline: connection.headline,
      tags: this.prepareConnectionTags(connection),
    };
  }

  /**
   * Prepare and format message history for API requests
   *
   * @param connection - Connection with message history
   * @param maxMessages - Maximum number of messages to include
   * @returns Formatted message history
   */
  prepareMessageHistory(connection: Connection, maxMessages: number = 10): Message[] {
    if (!connection.message_history || connection.message_history.length === 0) {
      return [];
    }

    // Sort messages by timestamp (most recent first) and limit
    const sortedMessages = [...connection.message_history]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, maxMessages);

    // Validate and clean message data
    return sortedMessages
      .filter((message) => this.isValidMessage(message))
      .map((message) => this.sanitizeMessage(message));
  }

  /**
   * Prepare user profile data for API inclusion
   *
   * @param userProfile - Raw user profile data
   * @returns Formatted user profile for API
   */
  prepareUserProfileData(userProfile: UserProfile): UserProfile {
    // Create a clean copy with only relevant fields
    return {
      user_id: userProfile.user_id,
      first_name: userProfile.first_name || '',
      last_name: userProfile.last_name || '',
      email: userProfile.email,
      headline: userProfile.headline || '',
      current_position: userProfile.current_position || '',
      company: userProfile.company || '',
      industry: userProfile.industry || '',
      interests: userProfile.interests || [],
      created_at: userProfile.created_at,
      updated_at: userProfile.updated_at,
      // Remove preferences field - not defined in UserProfile interface
    };
  }

  /**
   * Prepare conversation topic and context
   *
   * @param topic - Raw conversation topic
   * @returns Cleaned and formatted topic
   */
  prepareConversationTopic(topic: string): string {
    if (!topic || typeof topic !== 'string') {
      throw new Error('Conversation topic is required and must be a string');
    }

    // Clean and normalize the topic
    const cleanedTopic = topic.trim().replace(/\s+/g, ' ');

    if (cleanedTopic.length === 0) {
      throw new Error('Conversation topic is required and must be a string');
    }

    return cleanedTopic;
  }

  /**
   * Prepare connection tags and common interests
   *
   * @param connection - Connection object
   * @returns Array of relevant tags and interests
   */
  prepareConnectionTags(connection: Connection): string[] {
    const tags: string[] = [];

    // Add explicit tags
    if (connection.tags && Array.isArray(connection.tags)) {
      tags.push(...connection.tags);
    }

    // Add common interests
    if (connection.common_interests && Array.isArray(connection.common_interests)) {
      tags.push(...connection.common_interests);
    }

    // Remove duplicates and empty values
    return [...new Set(tags.filter((tag) => tag && tag.trim().length > 0))];
  }

  /**
   * Create a complete MessageGenerationRequest from context data
   *
   * @param context - Prepared message generation context
   * @returns Complete API request object
   */
  createMessageGenerationRequest(context: MessageGenerationContext): MessageGenerationRequest {
    return {
      connectionId: context.connection.id,
      connectionProfile: this.extractConnectionProfileData(context.connection),
      conversationTopic: context.topic,
      messageHistory: context.messageHistory,
      userProfile: context.userProfile,
    };
  }

  /**
   * Validate message data
   *
   * @param message - Message to validate
   * @returns True if message is valid
   */
  private isValidMessage(message: Message): boolean {
    return !!(message && message.id && message.content && message.timestamp && message.sender);
  }

  /**
   * Sanitize message content for API consumption
   *
   * @param message - Message to sanitize
   * @returns Sanitized message
   */
  private sanitizeMessage(message: Message): Message {
    return {
      id: message.id,
      content: message.content.trim(),
      timestamp: message.timestamp,
      sender: message.sender,
    };
  }

  /**
   * Get common interests between user and connection
   *
   * @param userProfile - User's profile
   * @param connection - Connection profile
   * @returns Array of common interests
   */
  findCommonInterests(userProfile: UserProfile, connection: Connection): string[] {
    if (!userProfile.interests || !connection.common_interests) {
      return [];
    }

    const userInterests = userProfile.interests.map((interest) => interest.toLowerCase());
    const connectionInterests = connection.common_interests.map((interest) =>
      interest.toLowerCase()
    );

    return userInterests.filter((interest) => connectionInterests.includes(interest));
  }

  /**
   * Calculate context relevance score
   *
   * @param context - Message generation context
   * @returns Relevance score (0-1)
   */
  calculateContextRelevance(context: MessageGenerationContext): number {
    let score = 0;
    let factors = 0;

    // Topic quality (0.3 weight)
    if (context.topic && context.topic.length > 10) {
      score += 0.3;
    }
    factors++;

    // Message history availability (0.2 weight)
    if (context.messageHistory.length > 0) {
      score += 0.2;
    }
    factors++;

    // User profile completeness (0.2 weight)
    if (context.userProfile && context.userProfile.headline && context.userProfile.company) {
      score += 0.2;
    }
    factors++;

    // Connection profile completeness (0.2 weight)
    if (context.connection.headline && context.connection.position) {
      score += 0.2;
    }
    factors++;

    // Common interests (0.1 weight)
    const commonInterests = this.findCommonInterests(context.userProfile, context.connection);
    if (commonInterests.length > 0) {
      score += 0.1;
    }
    factors++;

    return factors > 0 ? score : 0;
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

// Create singleton instance
export const connectionDataContextService = new ConnectionDataContextService();

// The service class is already exported above with `export class ConnectionDataContextService`

// Interfaces are already exported above with their declarations
