import { httpClient } from '@/shared/utils/httpClient';
import { ApiError } from '@/shared/utils/apiError';
import { logError } from '@/shared/utils/errorHandling';
import { createLogger } from '@/shared/utils/logger';
import { validateMessage, sanitizeMessageData } from '@/shared/types/validators';
import { isMessage } from '@/shared/types/guards';
import type { Message } from '@/shared/types';

const logger = createLogger('MessagesApiService');

class MessagesApiService {
  async getMessageHistory(connectionId: string): Promise<Message[]> {
    const context = 'fetch message history';
    if (!connectionId || typeof connectionId !== 'string') {
      throw new ApiError({ message: 'Connection ID is required', status: 400 });
    }

    const result = await httpClient.makeRequest<{
      messages: Message[];
      count: number;
    }>('edges', 'get_messages', { profileId: connectionId });

    if (!result.success) {
      logError(result.error, context, { connectionId, operation: 'get_messages' });
      throw new ApiError(result.error);
    }

    const messages = this.formatMessagesResponse(result.data.messages || []);
    logger.info(`Successfully fetched ${messages.length} messages for connection ${connectionId}`);
    return messages;
  }

  private formatMessagesResponse(messages: unknown[]): Message[] {
    if (!Array.isArray(messages)) {
      logger.warn('Invalid messages data received, expected array', { messages });
      return [];
    }

    return messages
      .map((msg, index) => {
        try {
          const validationResult = validateMessage(msg, { sanitize: false });
          if (validationResult.isValid && isMessage(msg)) {
            return msg as Message;
          }
          logger.warn(`Invalid message data at index ${index}`, {
            errors: validationResult.errors,
          });
        } catch (error) {
          logger.warn('Error formatting message validation', { error, msg });
        }

        try {
          const sanitized = sanitizeMessageData(msg);
          if (sanitized && isMessage(sanitized)) {
            logger.debug(`Successfully sanitized message data at index ${index}`);
            return sanitized;
          }
        } catch {
          // Suppress sanitization errors
        }

        logger.error(`Unable to sanitize message data at index ${index}`, { msg });
        return null;
      })
      .filter((msg): msg is Message => msg !== null);
  }
}

export const messagesApiService = new MessagesApiService();
