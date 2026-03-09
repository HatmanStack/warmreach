import { vi } from 'vitest';
import React, { type ReactNode } from 'react';
import { createWrapper } from './queryWrapper';
import { AuthContext, type User, type AuthContextType } from '@/features/auth/contexts/AuthContext';
import { UserProfileProvider } from '@/features/profile/contexts/UserProfileContext';
import { TierProvider } from '@/features/tier';
import { buildUserProfile } from './factories';

/**
 * Shared mock setup for axios.
 * NOTE: This is rarely used now that we have MSW for integration testing.
 * If used, call it BEFORE importing modules that use httpClient.
 */
export function mockAxiosPost() {
  const mockPost = vi.fn();
  vi.doMock('axios', () => ({
    default: {
      create: vi.fn(() => ({
        post: mockPost,
        get: vi.fn(),
        interceptors: {
          request: { use: vi.fn() },
          response: { use: vi.fn() },
        },
      })),
    },
  }));
  return mockPost;
}

/**
 * Shared mock for WebSocket service.
 */
export function mockWebSocketService() {
  const mockSend = vi.fn();
  const mockOnMessage = vi.fn(() => vi.fn()); // returns unsubscribe function

  vi.doMock('@/shared/services/websocketService', () => ({
    websocketService: {
      send: mockSend,
      onMessage: mockOnMessage,
      connect: vi.fn(),
      disconnect: vi.fn(),
    },
  }));

  return { mockSend, mockOnMessage };
}

/**
 * Wraps createWrapper() with mock providers for Auth, Profile, and Tier.
 * Useful for integration tests where hooks require full application context.
 */
export function createAuthenticatedWrapper(authOverrides: Partial<AuthContextType> = {}) {
  const QueryWrapper = createWrapper();

  const profile = buildUserProfile();
  const defaultUser: User = {
    id: profile.user_id,
    email: profile.email,
    firstName: profile.first_name,
    lastName: profile.last_name,
  };

  // Mock implementation of AuthContextType
  const mockAuthValue: AuthContextType = {
    user: defaultUser,
    loading: false,
    getToken: vi.fn().mockResolvedValue('mock-jwt-token'),
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
    ...authOverrides,
  };

  return ({ children }: { children: ReactNode }) => (
    <QueryWrapper>
      <AuthContext.Provider value={mockAuthValue}>
        <TierProvider>
          <UserProfileProvider>{children}</UserProfileProvider>
        </TierProvider>
      </AuthContext.Provider>
    </QueryWrapper>
  );
}
