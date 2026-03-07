import { describe, it, expect, vi, beforeEach } from 'vitest';
import { profileApiService } from './profileApiService';
import { httpClient } from '@/shared/utils/httpClient';

vi.mock('@/shared/utils/httpClient', () => ({
  httpClient: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

describe('ProfileApiService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getUserProfile', () => {
    it('should fetch user profile', async () => {
      const mockProfile = { user_id: 'u1', email: 'test@example.com' };
      vi.mocked(httpClient.get).mockResolvedValue({
        success: true,
        data: mockProfile,
      });

      const result = await profileApiService.getUserProfile();

      expect(httpClient.get).toHaveBeenCalledWith('profiles');
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockProfile);
    });

    it('should return error on failure', async () => {
      vi.mocked(httpClient.get).mockResolvedValue({
        success: false,
        error: { message: 'Fetch failed' },
      });

      const result = await profileApiService.getUserProfile();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Fetch failed');
    });
  });

  describe('updateUserProfile', () => {
    it('should update profile', async () => {
      const mockProfile = { firstName: 'Updated' };
      vi.mocked(httpClient.post).mockResolvedValue({
        success: true,
        data: { ...mockProfile, user_id: 'u1' },
      });

      const result = await profileApiService.updateUserProfile(mockProfile);

      expect(httpClient.post).toHaveBeenCalledWith('profiles', {
        operation: 'update_user_settings',
        ...mockProfile,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('createUserProfile', () => {
    it('should create profile', async () => {
      const mockProfile = { email: 'new@example.com', firstName: 'New' };
      vi.mocked(httpClient.post).mockResolvedValue({
        success: true,
        data: { ...mockProfile, user_id: 'u2' },
      });

      const result = await profileApiService.createUserProfile(mockProfile);

      expect(httpClient.post).toHaveBeenCalledWith('profiles', {
        operation: 'create_user_profile',
        ...mockProfile,
      });
      expect(result.success).toBe(true);
    });
  });
});
