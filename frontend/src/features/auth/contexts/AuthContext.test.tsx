import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// Hoisted mocks for CognitoAuthService
const {
  mockGetCurrentUser,
  mockSignIn,
  mockSignUp,
  mockSignOut,
  mockGetToken,
  mockConfirmSignUp,
  mockResendConfirmationCode,
  mockForgotPassword,
  mockConfirmPassword,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockSignIn: vi.fn(),
  mockSignUp: vi.fn(),
  mockSignOut: vi.fn(),
  mockGetToken: vi.fn(),
  mockConfirmSignUp: vi.fn(),
  mockResendConfirmationCode: vi.fn(),
  mockForgotPassword: vi.fn(),
  mockConfirmPassword: vi.fn(),
}));

// Mock the CognitoAuthService before importing AuthContext
vi.mock('../services/cognitoService', () => ({
  CognitoAuthService: {
    getCurrentUser: mockGetCurrentUser,
    signIn: mockSignIn,
    signUp: mockSignUp,
    signOut: mockSignOut,
    getCurrentUserToken: mockGetToken,
    confirmSignUp: mockConfirmSignUp,
    resendConfirmationCode: mockResendConfirmationCode,
    forgotPassword: mockForgotPassword,
    confirmPassword: mockConfirmPassword,
  },
}));

// Mock appConfig — default to mock mode (not configured)
const { mockIsCognitoConfigured } = vi.hoisted(() => ({
  mockIsCognitoConfigured: { value: false },
}));

vi.mock('@/config/appConfig', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    get isCognitoConfigured() {
      return mockIsCognitoConfigured.value;
    },
  };
});

import { AuthProvider, useAuth } from './AuthContext';

const Wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>;

describe('AuthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  describe('useAuth outside provider', () => {
    it('should throw when used outside AuthProvider', () => {
      // Suppress console error for expected throw
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => renderHook(() => useAuth())).toThrow(
        'useAuth must be used within an AuthProvider'
      );
      consoleSpy.mockRestore();
    });
  });

  describe('mock mode (Cognito not configured)', () => {
    beforeEach(() => {
      mockIsCognitoConfigured.value = false;
      vi.mocked(mockGetCurrentUser).mockResolvedValue(null);
    });

    it('should initialize with no user and finish loading', async () => {
      const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.user).toBeNull();
    });

    it('should hydrate user from localStorage', async () => {
      const mockUser = {
        id: 'mock-123',
        email: 'test@example.com',
        firstName: 'Mock',
        lastName: 'User',
        emailVerified: true,
      };
      window.localStorage.setItem('warmreach_user', JSON.stringify(mockUser));

      const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.user).toEqual(mockUser);
    });

    it('should clear invalid stored user', async () => {
      window.localStorage.setItem('warmreach_user', 'invalid-json');

      const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.user).toBeNull();
      expect(window.localStorage.getItem('warmreach_user')).toBeNull();
    });

    it('should sign in successfully in mock mode', async () => {
      const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let signInResult: { error: unknown };
      await act(async () => {
        signInResult = await result.current.signIn('test@example.com', 'anything');
      });

      expect(signInResult!.error).toBeNull();
      expect(result.current.user).not.toBeNull();
      expect(result.current.user?.email).toBe('test@example.com');
      // Verify user persisted to localStorage
      const stored = window.localStorage.getItem('warmreach_user');
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!).email).toBe('test@example.com');
    });

    it('should sign out successfully in mock mode', async () => {
      const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      // Sign in first
      await act(async () => {
        await result.current.signIn('signout@example.com', 'pass');
      });
      expect(result.current.user).not.toBeNull();

      // Now sign out
      await act(async () => {
        await result.current.signOut();
      });

      expect(result.current.user).toBeNull();
      expect(window.localStorage.getItem('warmreach_user')).toBeNull();
    });

    it('should sign up successfully in mock mode', async () => {
      const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let signUpResult: { error: unknown };
      await act(async () => {
        signUpResult = await result.current.signUp('new@e.com', 'p', 'N', 'U');
      });

      expect(signUpResult!.error).toBeNull();
      expect(result.current.user?.email).toBe('new@e.com');
    });

    it('should handle getToken in mock mode', async () => {
      const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      // No user signed in — token should be null
      const noUserToken = await result.current.getToken();
      expect(noUserToken).toBeNull();

      // Sign in, then token should be available
      await act(async () => {
        await result.current.signIn('test@example.com', 'pass');
      });
      const token = await result.current.getToken();
      expect(token).toBe('mock-jwt-token');
    });
  });

  describe('Cognito mode', () => {
    // These tests simulate behavior when Cognito environment variables are present
    // which triggers the use of CognitoAuthService instead of localStorage mocks.
    beforeEach(() => {
      mockIsCognitoConfigured.value = true;
    });

    it('should hydrate user from Cognito session', async () => {
      const mockUser = { id: 'c1', email: 'c@e.com', firstName: 'C', lastName: 'U' };
      mockGetCurrentUser.mockResolvedValue(mockUser);

      const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.user).toEqual(mockUser);
      expect(mockGetCurrentUser).toHaveBeenCalled();
    });

    it('should sign in via Cognito', async () => {
      const mockUser = { id: 'c2', email: 'signin@e.com', firstName: 'S', lastName: 'U' };
      mockGetCurrentUser.mockResolvedValue(null);
      mockSignIn.mockResolvedValue({ user: mockUser, error: null });

      const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let signInResult: { error: unknown };
      await act(async () => {
        signInResult = await result.current.signIn('signin@e.com', 'Pass123!');
      });

      expect(signInResult!.error).toBeNull();
      expect(result.current.user).toEqual(mockUser);
      expect(mockSignIn).toHaveBeenCalledWith('signin@e.com', 'Pass123!');
    });

    it('should return Cognito sign-in error', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockSignIn.mockResolvedValue({
        user: null,
        error: { message: 'Incorrect username or password.' },
      });

      const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let signInResult: { error: { message: string } };
      await act(async () => {
        signInResult = (await result.current.signIn('wrong@e.com', 'wrong')) as any;
      });

      expect(signInResult!.error).not.toBeNull();
      expect(signInResult!.error!.message).toBe('Incorrect username or password.');
      expect(result.current.user).toBeNull();
    });

    it('should sign out via Cognito', async () => {
      const mockUser = { id: 'c3', email: 'out@e.com', firstName: 'O', lastName: 'U' };
      mockGetCurrentUser.mockResolvedValue(mockUser);
      mockSignOut.mockResolvedValue(undefined);

      const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });

      await waitFor(() => {
        expect(result.current.user).not.toBeNull();
      });

      await act(async () => {
        await result.current.signOut();
      });

      expect(result.current.user).toBeNull();
      expect(mockSignOut).toHaveBeenCalled();
    });

    it('should get token from Cognito', async () => {
      mockGetToken.mockResolvedValue('real-jwt-token');
      const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });

      const token = await result.current.getToken();
      expect(token).toBe('real-jwt-token');
      expect(mockGetToken).toHaveBeenCalled();
    });

    it('should sign up via Cognito', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockSignUp.mockResolvedValue({ user: { id: 'new-c' }, error: null });

      const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let signUpResult: { error: unknown };
      await act(async () => {
        signUpResult = await result.current.signUp('new@e.com', 'p', 'N', 'U');
      });

      expect(signUpResult!.error).toBeNull();
      // Cognito signUp doesn't set user - needs email verification first
      expect(result.current.user).toBeNull();
    });

    it('should expose Cognito-specific methods', async () => {
      const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.confirmSignUp).toBeDefined();
      expect(result.current.resendConfirmationCode).toBeDefined();
      expect(result.current.forgotPassword).toBeDefined();
      expect(result.current.confirmPassword).toBeDefined();
    });

    it('should delegate confirmSignUp to Cognito', async () => {
      mockConfirmSignUp.mockResolvedValue({ error: null });
      const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let confirmResult: { error: unknown };
      await act(async () => {
        confirmResult = await result.current.confirmSignUp!('test@example.com', '123456');
      });

      expect(confirmResult!.error).toBeNull();
      expect(mockConfirmSignUp).toHaveBeenCalledWith('test@example.com', '123456');
    });

    it('should delegate forgotPassword to Cognito', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockForgotPassword.mockResolvedValue({ error: null });

      const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      let fpResult: { error: unknown };
      await act(async () => {
        fpResult = await result.current.forgotPassword!('test@example.com');
      });

      expect(fpResult!.error).toBeNull();
      expect(mockForgotPassword).toHaveBeenCalledWith('test@example.com');
    });
  });
});
