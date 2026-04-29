import { httpClient } from '@/shared/utils/httpClient';
import { createLogger } from '@/shared/utils/logger';
import type { UserProfile } from '@/shared/types';

const logger = createLogger('ProfileApiService');

class ProfileApiService {
  async getUserProfile(): Promise<{ success: boolean; data?: UserProfile; error?: string }> {
    logger.debug('Fetching user profile (GET /profiles)');
    // Backend wraps the GET body as { success, data: <profile> }. Unwrap
    // it here so callers consume the profile directly. The POST path
    // already returns a flat shape; eventually the GET endpoint should
    // match, at which point this fallback drops to a no-op.
    const result = await httpClient.get<{ success?: boolean; data?: UserProfile } | UserProfile>(
      'profiles'
    );
    if (!result.success) {
      return { success: false, error: result.error.message };
    }
    const body = result.data as { success?: boolean; data?: UserProfile } & UserProfile;
    const profile: UserProfile | undefined =
      body && typeof body === 'object' && 'data' in body ? body.data : (body as UserProfile);
    return { success: true, data: profile };
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
