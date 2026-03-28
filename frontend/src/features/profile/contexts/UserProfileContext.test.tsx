import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const { mockGetUserProfile, mockUpdateUserProfile, mockUser } = vi.hoisted(() => ({
  mockGetUserProfile: vi.fn(),
  mockUpdateUserProfile: vi.fn(),
  mockUser: {
    value: { id: 'user-1', email: 'test@example.com' } as Record<string, unknown> | null,
  },
}));

vi.mock('@/shared/services/profileApiService', () => ({
  profileApiService: {
    getUserProfile: mockGetUserProfile,
    updateUserProfile: mockUpdateUserProfile,
  },
}));

vi.mock('@/features/auth', () => ({
  useAuth: () => ({ user: mockUser.value }),
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { UserProfileProvider, useUserProfile } from './UserProfileContext';

function createWrapper() {
  return ({ children }: { children: ReactNode }) => (
    <UserProfileProvider>{children}</UserProfileProvider>
  );
}

describe('UserProfileContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockUser.value = { id: 'user-1', email: 'test@example.com' };
    mockGetUserProfile.mockResolvedValue({ success: true, data: null });
  });

  it('should throw when used outside provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useUserProfile())).toThrow(
      'useUserProfile must be used within a UserProfileProvider'
    );
    spy.mockRestore();
  });

  it('should initialize with null profile', async () => {
    const { result } = renderHook(() => useUserProfile(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.userProfile).toBeNull();
    expect(result.current.ciphertext).toBeNull();
  });

  describe('sessionStorage hydration for ciphertext', () => {
    it('should hydrate ciphertext with valid sealbox prefix', async () => {
      sessionStorage.setItem('li_credentials_ciphertext', 'sealbox_x25519:b64:encrypted_data');
      // Mark profile as already fetched to avoid API call
      sessionStorage.setItem('profile_fetched', 'true');

      const { result } = renderHook(() => useUserProfile(), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.ciphertext).toBe('sealbox_x25519:b64:encrypted_data');
      });
    });

    it('should reject ciphertext without valid prefix', async () => {
      sessionStorage.setItem('li_credentials_ciphertext', 'invalid_ciphertext');
      sessionStorage.setItem('profile_fetched', 'true');

      const { result } = renderHook(() => useUserProfile(), { wrapper: createWrapper() });

      // Wait for mount effect to run
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.ciphertext).toBeNull();
    });
  });

  describe('profile fetch on mount', () => {
    it('should fetch profile when not previously fetched', async () => {
      mockGetUserProfile.mockResolvedValue({
        success: true,
        data: {
          firstName: 'John',
          lastName: 'Doe',
          linkedin_credentials: 'sealbox_x25519:b64:creds',
        },
      });

      const { result } = renderHook(() => useUserProfile(), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.userProfile).not.toBeNull();
      expect(result.current.userProfile!.firstName).toBe('John');
      expect(result.current.ciphertext).toBe('sealbox_x25519:b64:creds');
      expect(mockGetUserProfile).toHaveBeenCalled();
    });

    it('should skip fetch when profile_fetched flag is set', async () => {
      sessionStorage.setItem('profile_fetched', 'true');

      const { result } = renderHook(() => useUserProfile(), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockGetUserProfile).not.toHaveBeenCalled();
    });

    it('should not fetch when no user', async () => {
      mockUser.value = null;

      renderHook(() => useUserProfile(), { wrapper: createWrapper() });

      // Wait a tick
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockGetUserProfile).not.toHaveBeenCalled();
    });
  });

  describe('updateUserProfile', () => {
    it('should call API and refresh profile', async () => {
      sessionStorage.setItem('profile_fetched', 'true');
      mockUpdateUserProfile.mockResolvedValue({ success: true });
      mockGetUserProfile.mockResolvedValue({
        success: true,
        data: { firstName: 'Updated', lastName: 'Name' },
      });

      const { result } = renderHook(() => useUserProfile(), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.updateUserProfile({ firstName: 'Updated' });
      });

      expect(mockUpdateUserProfile).toHaveBeenCalledWith({ firstName: 'Updated' });
      expect(mockGetUserProfile).toHaveBeenCalled(); // refresh after update
    });

    it('should throw on API failure', async () => {
      sessionStorage.setItem('profile_fetched', 'true');
      mockUpdateUserProfile.mockResolvedValue({ success: false, error: 'Validation error' });

      const { result } = renderHook(() => useUserProfile(), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await expect(
        act(async () => {
          await result.current.updateUserProfile({ firstName: '' });
        })
      ).rejects.toThrow('Validation error');
    });
  });

  describe('setCiphertext', () => {
    it('should persist valid ciphertext to sessionStorage', async () => {
      sessionStorage.setItem('profile_fetched', 'true');

      const { result } = renderHook(() => useUserProfile(), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      act(() => {
        result.current.setCiphertext('sealbox_x25519:b64:new_creds');
      });

      expect(result.current.ciphertext).toBe('sealbox_x25519:b64:new_creds');
      expect(sessionStorage.getItem('li_credentials_ciphertext')).toBe(
        'sealbox_x25519:b64:new_creds'
      );
    });

    it('should remove from sessionStorage when set to null', async () => {
      sessionStorage.setItem('profile_fetched', 'true');
      sessionStorage.setItem('li_credentials_ciphertext', 'sealbox_x25519:b64:old');

      const { result } = renderHook(() => useUserProfile(), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      act(() => {
        result.current.setCiphertext(null);
      });

      expect(result.current.ciphertext).toBeNull();
      expect(sessionStorage.getItem('li_credentials_ciphertext')).toBeNull();
    });
  });
});
