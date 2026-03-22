import { httpClient } from '@/shared/utils/httpClient';
import { ApiError } from '@/shared/utils/apiError';
import { logError } from '@/shared/utils/errorHandling';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('NotesApiService');

class NotesApiService {
  async addNote(profileId: string, content: string): Promise<{ noteId: string }> {
    const context = `add note for profile ${profileId}`;
    const result = await httpClient.makeRequest<{
      success: boolean;
      result: { noteId: string; profileId: string; success: boolean };
    }>('edges', 'add_note', { profileId, content });

    if (!result.success) {
      logError(result.error, context, { profileId, operation: 'add_note' });
      throw new ApiError(result.error);
    }

    logger.info(`Successfully added note for profile ${profileId}`);
    return result.data.result;
  }

  async updateNote(profileId: string, noteId: string, content: string): Promise<void> {
    const context = `update note ${noteId} for profile ${profileId}`;
    const result = await httpClient.makeRequest<{ success: boolean }>('edges', 'update_note', {
      profileId,
      noteId,
      content,
    });

    if (!result.success) {
      logError(result.error, context, { profileId, noteId, operation: 'update_note' });
      throw new ApiError(result.error);
    }

    logger.info(`Successfully updated note ${noteId} for profile ${profileId}`);
  }

  async deleteNote(profileId: string, noteId: string): Promise<void> {
    const context = `delete note ${noteId} for profile ${profileId}`;
    const result = await httpClient.makeRequest<{ success: boolean }>('edges', 'delete_note', {
      profileId,
      noteId,
    });

    if (!result.success) {
      logError(result.error, context, { profileId, noteId, operation: 'delete_note' });
      throw new ApiError(result.error);
    }

    logger.info(`Successfully deleted note ${noteId} for profile ${profileId}`);
  }
}

export const notesApiService = new NotesApiService();
