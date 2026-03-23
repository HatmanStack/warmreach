import { vi } from 'vitest';
import React, { type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { createWrapper } from './queryWrapper';
import { AuthContext, type User, type AuthContextType } from '@/features/auth/contexts/AuthContext';
import { UserProfileProvider } from '@/features/profile/contexts/UserProfileContext';
import { TierProvider, type TierContextType } from '@/features/tier';
import { type UseCommandReturn } from '@/shared/hooks/useCommand';
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
/**
 * Build a typed mock return value for useAuth().
 * Avoids `as any` when mocking useAuth in tests.
 */
export function buildMockAuthReturn(overrides: Partial<AuthContextType> = {}): AuthContextType {
  return {
    user: { id: 'test-user-id', email: 'test@example.com' },
    loading: false,
    getToken: vi.fn().mockResolvedValue('mock-token'),
    signIn: vi.fn().mockResolvedValue({ error: null }),
    signUp: vi.fn().mockResolvedValue({ error: null }),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Build a typed mock return value for useTier().
 * Avoids `as any` when mocking useTier in tests.
 */
export function buildMockTierReturn(overrides: Partial<TierContextType> = {}): TierContextType {
  return {
    tier: 'free',
    features: {},
    quotas: {},
    isFeatureEnabled: vi.fn().mockReturnValue(false),
    loading: false,
    ...overrides,
  };
}

/**
 * Build a typed mock return value for useToast().
 * Avoids `as any` when mocking useToast in tests.
 */
export function buildMockToastReturn(mockToast?: ReturnType<typeof vi.fn>) {
  const toastFn = mockToast ?? vi.fn();
  return {
    toasts: [] as Array<{ id: string; dismiss: () => void }>,
    toast: toastFn,
    dismiss: vi.fn(),
  };
}

/**
 * Build a typed mock return value for useCommand().
 * Avoids `as any` when mocking useCommand in tests.
 */
export function buildMockCommandReturn<T = unknown>(
  overrides: Partial<UseCommandReturn<T>> = {}
): UseCommandReturn<T> {
  return {
    execute: vi.fn(),
    status: 'idle',
    progress: null,
    result: null,
    error: null,
    reset: vi.fn(),
    ...overrides,
  };
}

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
      <MemoryRouter>
        <AuthContext.Provider value={mockAuthValue}>
          <TierProvider>
            <UserProfileProvider>{children}</UserProfileProvider>
          </TierProvider>
        </AuthContext.Provider>
      </MemoryRouter>
    </QueryWrapper>
  );
}
