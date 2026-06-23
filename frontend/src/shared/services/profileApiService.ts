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
    // Wrapped envelope with explicit success flag — honour it. A
    // success: false body should never propagate to callers as
    // success: true with undefined data.
    if (body && typeof body === 'object' && 'success' in body) {
      if (body.success === false) {
        return { success: false, error: 'Backend returned success: false' };
      }
      if (!body.data) {
        return { success: false, error: 'Backend returned success: true with no data' };
      }
      return { success: true, data: body.data };
    }
    // Unwrapped (legacy / POST shape) — body itself is the profile.
    // Mirror the wrapped-branch validation: don't claim success when
    // the body is null / not an object, otherwise callers get
    // success: true with bogus data.
    if (!body || typeof body !== 'object') {
      return { success: false, error: 'Backend returned success: true with no data' };
    }
    return { success: true, data: body as UserProfile };
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
