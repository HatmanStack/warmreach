import { vi } from 'vitest';
import React, { type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { createWrapper } from './queryWrapper';
import { AuthContext, type User, type AuthContextType } from '@/features/auth/contexts/AuthContext';
import { UserProfileProvider } from '@/features/profile/contexts/UserProfileContext';
import { TierProvider, type TierContextType } from '@/features/tier';
import { type UseCommandReturn } from '@/shared/hooks/useCommand';
import { buildUserProfile } from './factories';
import { useToast } from '@/shared/hooks';
import type { UseQueryResult } from '@tanstack/react-query';

/**
 * Shared mock setup for fetch.
 * NOTE: This is rarely used now that we have MSW for integration testing.
 */
export function mockFetchPost() {
  const mockFn = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    })
  );
  vi.stubGlobal('fetch', mockFn);
  return mockFn;
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
export function buildMockToastReturn(
  mockToast?: ReturnType<typeof vi.fn>
): ReturnType<typeof useToast> {
  // `vi.fn()` is Mock<Procedure | Constructable>, which is not assignable to
  // the real toast signature. One widening here so callers can keep writing
  // `const mockToast = vi.fn()` and still get a correctly typed return value —
  // the previous loose object literal silently drifted from useToast's shape.
  const toastFn = (mockToast ?? vi.fn()) as ReturnType<typeof useToast>['toast'];
  return {
    toasts: [],
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
  // UserProfile's fields are all optional; User requires id and email.
  const defaultUser: User = {
    id: profile.user_id ?? 'test-user-id',
    email: profile.email ?? 'test@example.com',
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

/**
 * Build a typed `useQuery` return value from the handful of fields a component
 * actually reads.
 *
 * React Query's UseQueryResult is a wide discriminated union with ~24 members,
 * so a fixture can never satisfy it structurally; tests were reaching for
 * `as ReturnType<typeof useQuery>`, which TypeScript rejects outright once test
 * files are checked ("neither type sufficiently overlaps"). One widening here,
 * with the readable fields kept typed on the way in.
 */
export function buildMockQueryResult<T>(partial: {
  data?: T | null;
  isLoading?: boolean;
  error?: Error | null;
  refetch?: ReturnType<typeof vi.fn>;
}): UseQueryResult<T, Error> {
  return {
    data: partial.data ?? undefined,
    isLoading: partial.isLoading ?? false,
    error: partial.error ?? null,
    refetch: partial.refetch ?? vi.fn(),
  } as unknown as UseQueryResult<T, Error>;
}
