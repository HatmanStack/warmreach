import { httpClient } from '@/shared/utils/httpClient';
import { createLogger } from '@/shared/utils/logger';
import { ApiError } from '@/shared/utils/apiError';
import type { UserProfile } from '@/shared/types';

const logger = createLogger('ProfileApiService');

export class ProfileApiService {
    async getUserProfile(): Promise<{ success: boolean; data?: UserProfile; error?: string }> {
        try {
            logger.debug('Fetching user profile (GET /profiles)');
            const response = await httpClient.get<UserProfile>('profiles');
            return { success: true, data: response };
        } catch (error) {
            if (error instanceof ApiError) {
                return { success: false, error: error.message };
            }
            return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch profile' };
        }
    }

    async updateUserProfile(
        profile: Partial<UserProfile>
    ): Promise<{ success: boolean; data?: UserProfile; error?: string }> {
        try {
            logger.debug('Updating profile (POST /profiles)', { profileKeys: Object.keys(profile) });
            const response = await httpClient.post<UserProfile>('profiles', {
                operation: 'update_user_settings',
                ...profile,
            });
            return { success: true, data: response };
        } catch (error) {
            if (error instanceof ApiError) {
                return { success: false, error: error.message };
            }
            return { success: false, error: error instanceof Error ? error.message : 'Failed to update profile' };
        }
    }

    async createUserProfile(
        profile: Omit<UserProfile, 'user_id' | 'created_at' | 'updated_at'>
    ): Promise<{ success: boolean; data?: UserProfile; error?: string }> {
        try {
            const response = await httpClient.post<UserProfile>('profiles', {
                operation: 'create_user_profile',
                ...profile,
            });
            return { success: true, data: response };
        } catch (error) {
            if (error instanceof ApiError) {
                return { success: false, error: error.message };
            }
            return { success: false, error: error instanceof Error ? error.message : 'Failed to create profile' };
        }
    }
}

export const profileApiService = new ProfileApiService();
