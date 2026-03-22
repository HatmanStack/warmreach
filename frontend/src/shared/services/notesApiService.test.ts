import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notesApiService } from './notesApiService';
import { httpClient } from '@/shared/utils/httpClient';
import { ApiError } from '@/shared/utils/apiError';

vi.mock('@/shared/utils/httpClient', () => ({
  httpClient: {
    makeRequest: vi.fn(),
  },
}));

describe('NotesApiService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('addNote', () => {
    it('should call httpClient with correct endpoint and params', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: { success: true, result: { noteId: 'n1', profileId: 'p1', success: true } },
      });

      const result = await notesApiService.addNote('p1', 'Test note content');

      expect(httpClient.makeRequest).toHaveBeenCalledWith('edges', 'add_note', {
        profileId: 'p1',
        content: 'Test note content',
      });
      expect(result.noteId).toBe('n1');
    });

    it('should throw ApiError on failure', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: false,
        error: { message: 'Failed to add note' },
        data: null,
      });

      await expect(notesApiService.addNote('p1', 'content')).rejects.toThrow(ApiError);
    });
  });

  describe('updateNote', () => {
    it('should call httpClient with correct params including noteId', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: { success: true },
      });

      await notesApiService.updateNote('p1', 'n1', 'Updated content');

      expect(httpClient.makeRequest).toHaveBeenCalledWith('edges', 'update_note', {
        profileId: 'p1',
        noteId: 'n1',
        content: 'Updated content',
      });
    });

    it('should throw ApiError on failure', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: false,
        error: { message: 'Failed to update note' },
        data: null,
      });

      await expect(notesApiService.updateNote('p1', 'n1', 'content')).rejects.toThrow(ApiError);
    });
  });

  describe('deleteNote', () => {
    it('should call httpClient with correct params', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: true,
        data: { success: true },
      });

      await notesApiService.deleteNote('p1', 'n1');

      expect(httpClient.makeRequest).toHaveBeenCalledWith('edges', 'delete_note', {
        profileId: 'p1',
        noteId: 'n1',
      });
    });

    it('should throw ApiError on failure', async () => {
      vi.mocked(httpClient.makeRequest).mockResolvedValue({
        success: false,
        error: { message: 'Failed to delete note' },
        data: null,
      });

      await expect(notesApiService.deleteNote('p1', 'n1')).rejects.toThrow(ApiError);
    });
  });
});
