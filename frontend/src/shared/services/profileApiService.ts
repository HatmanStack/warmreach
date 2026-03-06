import { httpClient } from '@/shared/utils/httpClient';
import { createLogger } from '@/shared/utils/logger';
import type { UserProfile } from '@/shared/types';

const logger = createLogger('ProfileApiService');

class ProfileApiService {
  async getUserProfile(): Promise<{ success: boolean; data?: UserProfile; error?: string }> {
    logger.debug('Fetching user profile (GET /profiles)');
    const result = await httpClient.get<UserProfile>('profiles');
    if (!result.success) {
      return { success: false, error: result.error.message };
    }
    return { success: true, data: result.data };
  }

  async updateUserProfile(
    profile: Partial<UserProfile>
  ): Promise<{ success: boolean; data?: UserProfile; error?: string }> {
    logger.debug('Updating profile (POST /profiles)', { profileKeys: Object.keys(profile) });
    const result = await httpClient.post<UserProfile>('profiles', {
      operation: 'update_user_settings',
      ...profile,
    });
    if (!result.success) {
      return { success: false, error: result.error.message };
    }
    return { success: true, data: result.data };
  }

  async createUserProfile(
    profile: Omit<UserProfile, 'user_id' | 'created_at' | 'updated_at'>
  ): Promise<{ success: boolean; data?: UserProfile; error?: string }> {
    const result = await httpClient.post<UserProfile>('profiles', {
      operation: 'create_user_profile',
      ...profile,
    });
    if (!result.success) {
      return { success: false, error: result.error.message };
    }
    return { success: true, data: result.data };
  }
}

export const profileApiService = new ProfileApiService();
