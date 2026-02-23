import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CognitoUserSession } from 'amazon-cognito-identity-js';

// Define mocks with vi.hoisted so they're available in hoisted vi.mock factories
const {
  mockSignUp,
  mockGetCurrentUser,
  mockAuthenticateUser,
  mockGetUserAttributes,
  mockCompleteNewPasswordChallenge,
  mockSignOut,
  mockGetSession,
  mockConfirmRegistration,
  mockResendConfirmationCode,
  mockForgotPassword,
  mockConfirmPassword,
} = vi.hoisted(() => ({
  mockSignUp: vi.fn(),
  mockGetCurrentUser: vi.fn(),
  mockAuthenticateUser: vi.fn(),
  mockGetUserAttributes: vi.fn(),
  mockCompleteNewPasswordChallenge: vi.fn(),
  mockSignOut: vi.fn(),
  mockGetSession: vi.fn(),
  mockConfirmRegistration: vi.fn(),
  mockResendConfirmationCode: vi.fn(),
  mockForgotPassword: vi.fn(),
  mockConfirmPassword: vi.fn(),
}));

vi.mock('amazon-cognito-identity-js', () => {
  return {
    CognitoUserPool: class {
      signUp = mockSignUp;
      getCurrentUser = mockGetCurrentUser;
    },
    CognitoUser: class {
      authenticateUser = mockAuthenticateUser;
      getUserAttributes = mockGetUserAttributes;
      completeNewPasswordChallenge = mockCompleteNewPasswordChallenge;
      signOut = mockSignOut;
      getSession = mockGetSession;
      confirmRegistration = mockConfirmRegistration;
      resendConfirmationCode = mockResendConfirmationCode;
      forgotPassword = mockForgotPassword;
      confirmPassword = mockConfirmPassword;
    },
    AuthenticationDetails: class {},
    CognitoUserAttribute: class {
      private data: { Name: string; Value: string };
      constructor(data: { Name: string; Value: string }) {
        this.data = data;
      }
      getName() {
        return this.data.Name;
      }
      getValue() {
        return this.data.Value;
      }
    },
    CognitoUserSession: class {},
  };
});

vi.mock('@/config/appConfig', () => ({
  cognitoConfig: {
    userPoolId: 'us-east-1_TestPool',
    userPoolWebClientId: 'test-client-id',
  },
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { CognitoAuthService } from './cognitoService';

// Helper to create a mock session
function createMockSession(sub = 'user-123'): CognitoUserSession {
  return {
    getIdToken: () => ({
      payload: { sub },
      getJwtToken: () => 'mock-jwt-token',
    }),
    isValid: () => true,
  } as unknown as CognitoUserSession;
}

// Helper to create mock attributes
function createMockAttributes(attrs: Record<string, string> = {}) {
  const defaults = {
    email: 'test@example.com',
    given_name: 'John',
    family_name: 'Doe',
    email_verified: 'true',
    ...attrs,
  };
  return Object.entries(defaults).map(([Name, Value]) => ({
    getName: () => Name,
    getValue: () => Value,
  }));
}

describe('CognitoAuthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('signUp', () => {
    it('should return user data on success', async () => {
      mockSignUp.mockImplementation((_email, _password, _attrs, _validation, callback) => {
        callback(null, {
          userSub: 'new-user-123',
          user: { getUsername: () => 'test@example.com' },
        });
      });

      const result = await CognitoAuthService.signUp(
        'test@example.com',
        'Password1!',
        'John',
        'Doe'
      );

      expect(result.error).toBeNull();
      expect(result.user).toBeDefined();
      expect(result.user!.id).toBe('new-user-123');
      expect(result.user!.email).toBe('test@example.com');
      expect(result.user!.firstName).toBe('John');
      expect(result.user!.lastName).toBe('Doe');
    });

    it('should return error on Cognito failure', async () => {
      mockSignUp.mockImplementation((_email, _password, _attrs, _validation, callback) => {
        callback(new Error('User already exists'));
      });

      const result = await CognitoAuthService.signUp('test@example.com', 'Password1!');

      expect(result.error).not.toBeNull();
      expect(result.error!.message).toBe('User already exists');
      expect(result.user).toBeUndefined();
    });

    it('should include optional name attributes', async () => {
      mockSignUp.mockImplementation((_email, _password, attrs, _validation, callback) => {
        callback(null, {
          userSub: 'sub-1',
          user: { getUsername: () => 'test@example.com' },
        });
      });

      await CognitoAuthService.signUp('test@example.com', 'Pass1!', 'Jane', 'Smith');

      // The attrs argument (index 2) should include email + given_name + family_name
      const attrArg = mockSignUp.mock.calls[0][2];
      expect(attrArg).toHaveLength(3);
    });
  });

  describe('signIn', () => {
    it('should return user data on success', async () => {
      const mockSession = createMockSession();
      const mockAttrs = createMockAttributes();

      mockAuthenticateUser.mockImplementation((_details, callbacks) => {
        callbacks.onSuccess(mockSession);
      });
      mockGetUserAttributes.mockImplementation((callback: (...args: unknown[]) => void) => {
        callback(null, mockAttrs);
      });

      const result = await CognitoAuthService.signIn('test@example.com', 'Password1!');

      expect(result.error).toBeNull();
      expect(result.user).toBeDefined();
      expect(result.user!.id).toBe('user-123');
      expect(result.user!.email).toBe('test@example.com');
      expect(result.user!.firstName).toBe('John');
      expect(result.user!.lastName).toBe('Doe');
    });

    it('should return error on wrong credentials', async () => {
      mockAuthenticateUser.mockImplementation((_details, callbacks) => {
        callbacks.onFailure({
          message: 'Incorrect username or password.',
          code: 'NotAuthorizedException',
        });
      });

      const result = await CognitoAuthService.signIn('test@example.com', 'wrong');

      expect(result.error).not.toBeNull();
      expect(result.error!.message).toBe('Incorrect username or password.');
      expect(result.error!.code).toBe('NotAuthorizedException');
    });

    it('should handle newPasswordRequired challenge', async () => {
      const mockSession = createMockSession();
      const mockAttrs = createMockAttributes();

      mockAuthenticateUser.mockImplementation((_details, callbacks) => {
        callbacks.newPasswordRequired({ email: 'test@example.com', email_verified: 'true' });
      });
      mockCompleteNewPasswordChallenge.mockImplementation((_password, _attrs, callbacks) => {
        callbacks.onSuccess(mockSession);
      });
      mockGetUserAttributes.mockImplementation((callback: (...args: unknown[]) => void) => {
        callback(null, mockAttrs);
      });

      const result = await CognitoAuthService.signIn('test@example.com', 'Password1!');

      expect(result.error).toBeNull();
      expect(result.user).toBeDefined();
      expect(result.user!.id).toBe('user-123');
      // Verify read-only attributes were stripped before challenge completion
      const challengeAttrs = mockCompleteNewPasswordChallenge.mock.calls[0][1];
      expect(challengeAttrs).not.toHaveProperty('email');
      expect(challengeAttrs).not.toHaveProperty('email_verified');
    });

    it('should return error when getUserAttributes fails after auth', async () => {
      const mockSession = createMockSession();

      mockAuthenticateUser.mockImplementation((_details, callbacks) => {
        callbacks.onSuccess(mockSession);
      });
      mockGetUserAttributes.mockImplementation((callback: (...args: unknown[]) => void) => {
        callback(new Error('Failed to get attributes'));
      });

      const result = await CognitoAuthService.signIn('test@example.com', 'Password1!');

      expect(result.error).not.toBeNull();
      expect(result.error!.message).toBe('Failed to get attributes');
    });

    it('should return error when newPasswordRequired challenge fails', async () => {
      mockAuthenticateUser.mockImplementation((_details, callbacks) => {
        callbacks.newPasswordRequired({});
      });
      mockCompleteNewPasswordChallenge.mockImplementation((_password, _attrs, callbacks) => {
        callbacks.onFailure({
          message: 'Password does not meet requirements',
          code: 'InvalidPasswordException',
        });
      });

      const result = await CognitoAuthService.signIn('test@example.com', 'weak');

      expect(result.error).not.toBeNull();
      expect(result.error!.message).toBe('Password does not meet requirements');
    });
  });

  describe('signOut', () => {
    it('should call signOut on current user', async () => {
      const mockUser = { signOut: mockSignOut };
      mockGetCurrentUser.mockReturnValue(mockUser);

      await CognitoAuthService.signOut();

      expect(mockSignOut).toHaveBeenCalled();
    });

    it('should handle no current user gracefully', async () => {
      mockGetCurrentUser.mockReturnValue(null);

      await CognitoAuthService.signOut();
      // Should not throw
    });
  });

  describe('getCurrentUser', () => {
    it('should return user data for valid session', async () => {
      const mockSession = createMockSession();
      const mockAttrs = createMockAttributes();
      const mockUser = {
        getSession: mockGetSession,
        getUserAttributes: mockGetUserAttributes,
      };
      mockGetCurrentUser.mockReturnValue(mockUser);
      mockGetSession.mockImplementation((callback: (...args: unknown[]) => void) => {
        callback(null, mockSession);
      });
      mockGetUserAttributes.mockImplementation((callback: (...args: unknown[]) => void) => {
        callback(null, mockAttrs);
      });

      const user = await CognitoAuthService.getCurrentUser();

      expect(user).not.toBeNull();
      expect(user!.id).toBe('user-123');
      expect(user!.email).toBe('test@example.com');
      expect(user!.emailVerified).toBe(true);
    });

    it('should return null when no current user', async () => {
      mockGetCurrentUser.mockReturnValue(null);

      const user = await CognitoAuthService.getCurrentUser();

      expect(user).toBeNull();
    });

    it('should return null on session error', async () => {
      const mockUser = { getSession: mockGetSession };
      mockGetCurrentUser.mockReturnValue(mockUser);
      mockGetSession.mockImplementation((callback: (...args: unknown[]) => void) => {
        callback(new Error('Session expired'));
      });

      const user = await CognitoAuthService.getCurrentUser();

      expect(user).toBeNull();
    });

    it('should return null on invalid session', async () => {
      const invalidSession = { isValid: () => false } as unknown as CognitoUserSession;
      const mockUser = { getSession: mockGetSession };
      mockGetCurrentUser.mockReturnValue(mockUser);
      mockGetSession.mockImplementation((callback: (...args: unknown[]) => void) => {
        callback(null, invalidSession);
      });

      const user = await CognitoAuthService.getCurrentUser();

      expect(user).toBeNull();
    });

    it('should return null when getUserAttributes fails', async () => {
      const mockSession = createMockSession();
      const mockUser = {
        getSession: mockGetSession,
        getUserAttributes: mockGetUserAttributes,
      };
      mockGetCurrentUser.mockReturnValue(mockUser);
      mockGetSession.mockImplementation((callback: (...args: unknown[]) => void) => {
        callback(null, mockSession);
      });
      mockGetUserAttributes.mockImplementation((callback: (...args: unknown[]) => void) => {
        callback(new Error('Attributes error'));
      });

      const user = await CognitoAuthService.getCurrentUser();

      expect(user).toBeNull();
    });
  });

  describe('confirmSignUp', () => {
    it('should resolve with no error on success', async () => {
      mockConfirmRegistration.mockImplementation((_code, _forceAlias, callback) => {
        callback(null);
      });

      const result = await CognitoAuthService.confirmSignUp('test@example.com', '123456');

      expect(result.error).toBeNull();
    });

    it('should return error on invalid code', async () => {
      mockConfirmRegistration.mockImplementation((_code, _forceAlias, callback) => {
        callback(new Error('Invalid verification code'));
      });

      const result = await CognitoAuthService.confirmSignUp('test@example.com', 'wrong');

      expect(result.error).not.toBeNull();
      expect(result.error!.message).toBe('Invalid verification code');
    });
  });

  describe('resendConfirmationCode', () => {
    it('should resolve with no error on success', async () => {
      mockResendConfirmationCode.mockImplementation((callback) => {
        callback(null);
      });

      const result = await CognitoAuthService.resendConfirmationCode('test@example.com');

      expect(result.error).toBeNull();
    });

    it('should return error on failure', async () => {
      mockResendConfirmationCode.mockImplementation((callback) => {
        callback(new Error('Rate limit exceeded'));
      });

      const result = await CognitoAuthService.resendConfirmationCode('test@example.com');

      expect(result.error).not.toBeNull();
      expect(result.error!.message).toBe('Rate limit exceeded');
    });
  });

  describe('forgotPassword', () => {
    it('should resolve with no error on success', async () => {
      mockForgotPassword.mockImplementation((callbacks) => {
        callbacks.onSuccess();
      });

      const result = await CognitoAuthService.forgotPassword('test@example.com');

      expect(result.error).toBeNull();
    });

    it('should return error on failure', async () => {
      mockForgotPassword.mockImplementation((callbacks) => {
        callbacks.onFailure(new Error('User not found'));
      });

      const result = await CognitoAuthService.forgotPassword('test@example.com');

      expect(result.error).not.toBeNull();
      expect(result.error!.message).toBe('User not found');
    });
  });

  describe('confirmPassword', () => {
    it('should resolve with no error on success', async () => {
      mockConfirmPassword.mockImplementation((_code, _newPass, callbacks) => {
        callbacks.onSuccess();
      });

      const result = await CognitoAuthService.confirmPassword(
        'test@example.com',
        '123456',
        'NewPass1!'
      );

      expect(result.error).toBeNull();
    });

    it('should return error on failure', async () => {
      mockConfirmPassword.mockImplementation((_code, _newPass, callbacks) => {
        callbacks.onFailure(new Error('Code expired'));
      });

      const result = await CognitoAuthService.confirmPassword(
        'test@example.com',
        'expired',
        'NewPass1!'
      );

      expect(result.error).not.toBeNull();
      expect(result.error!.message).toBe('Code expired');
    });
  });

  describe('getCurrentUserToken', () => {
    it('should return JWT token for valid session', async () => {
      const mockSession = createMockSession();
      const mockUser = { getSession: mockGetSession };
      mockGetCurrentUser.mockReturnValue(mockUser);
      mockGetSession.mockImplementation((callback: (...args: unknown[]) => void) => {
        callback(null, mockSession);
      });

      const token = await CognitoAuthService.getCurrentUserToken();

      expect(token).toBe('mock-jwt-token');
    });

    it('should return null when no current user', async () => {
      mockGetCurrentUser.mockReturnValue(null);

      const token = await CognitoAuthService.getCurrentUserToken();

      expect(token).toBeNull();
    });

    it('should return null on session error', async () => {
      const mockUser = { getSession: mockGetSession };
      mockGetCurrentUser.mockReturnValue(mockUser);
      mockGetSession.mockImplementation((callback: (...args: unknown[]) => void) => {
        callback(new Error('Session expired'));
      });

      const token = await CognitoAuthService.getCurrentUserToken();

      expect(token).toBeNull();
    });

    it('should return null on invalid session', async () => {
      const invalidSession = { isValid: () => false } as unknown as CognitoUserSession;
      const mockUser = { getSession: mockGetSession };
      mockGetCurrentUser.mockReturnValue(mockUser);
      mockGetSession.mockImplementation((callback: (...args: unknown[]) => void) => {
        callback(null, invalidSession);
      });

      const token = await CognitoAuthService.getCurrentUserToken();

      expect(token).toBeNull();
    });
  });
});
