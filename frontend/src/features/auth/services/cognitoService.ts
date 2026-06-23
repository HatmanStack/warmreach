import {
  CognitoUserPool,
  CognitoUser as CognitoUserClass,
  AuthenticationDetails,
  CognitoUserAttribute,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { cognitoConfig } from '@/config/appConfig';
import { createLogger } from '@/shared/utils/logger';
import type { AuthError, CognitoAttributeList } from '../types';

const logger = createLogger('CognitoService');

// Initialize Cognito User Pool
const userPool = new CognitoUserPool({
  UserPoolId: cognitoConfig.userPoolId,
  ClientId: cognitoConfig.userPoolWebClientId,
});

// Prefix the amazon-cognito-identity-js SDK uses for every key it writes to
// localStorage (e.g. `...<clientId>.<username>.idToken`, `.accessToken`,
// `.refreshToken`, `.clockDrift`, and `...LastAuthUser`). Removing all keys
// with this prefix clears the locally-cached tokens on logout.
const COGNITO_STORAGE_PREFIX = 'CognitoIdentityServiceProvider.';

// Purge the SDK's locally-cached Cognito tokens. Iterates over a snapshot of
// the key list (collect first, then remove) to avoid index-shift bugs while
// deleting, and swallows storage errors to match the codebase's
// storage-access pattern.
//
// Known limitation (CRITICAL #5, PARTIAL): the SDK keeps tokens in
// JS-readable localStorage by default; this purge runs at logout but does not
// change the storage backend — see signOut().
function purgeCognitoStorage(): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(COGNITO_STORAGE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch {
    // localStorage may be unavailable (private mode, disabled) — ignore.
  }
}

// Helper function to extract user data from Cognito attributes
function extractUserData(
  session: CognitoUserSession,
  attributes: CognitoAttributeList,
  email: string
): CognitoUserData {
  const userAttributes: { [key: string]: string } = {};
  attributes?.forEach((attr) => {
    userAttributes[attr.getName()] = attr.getValue();
  });

  return {
    id: session.getIdToken().payload.sub,
    email: userAttributes.email || email,
    firstName: userAttributes.given_name,
    lastName: userAttributes.family_name,
    emailVerified: userAttributes.email_verified === 'true',
  };
}

export interface CognitoUserData {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  emailVerified?: boolean;
}

export class CognitoAuthService {
  // Sign up a new user
  static async signUp(
    email: string,
    password: string,
    firstName?: string,
    lastName?: string
  ): Promise<{
    error: AuthError | null;
    user?: {
      id: string;
      email: string;
      firstName?: string;
      lastName?: string;
      needsVerification: boolean;
    };
  }> {
    return new Promise((resolve) => {
      const attributeList = [
        new CognitoUserAttribute({
          Name: 'email',
          Value: email,
        }),
      ];

      if (firstName) {
        attributeList.push(
          new CognitoUserAttribute({
            Name: 'given_name',
            Value: firstName,
          })
        );
      }

      if (lastName) {
        attributeList.push(
          new CognitoUserAttribute({
            Name: 'family_name',
            Value: lastName,
          })
        );
      }

      userPool.signUp(email, password, attributeList, [], (err, result) => {
        if (err) {
          resolve({ error: { message: err.message } });
          return;
        }

        resolve({
          error: null,
          user: {
            id: result?.userSub || '',
            email,
            firstName,
            lastName,
            needsVerification: !result?.user.getUsername(),
          },
        });
      });
    });
  }

  // Sign in an existing user
  static async signIn(
    email: string,
    password: string
  ): Promise<{ error: AuthError | null; user?: CognitoUserData }> {
    return new Promise((resolve) => {
      const authenticationDetails = new AuthenticationDetails({
        Username: email,
        Password: password,
      });

      const cognitoUser = new CognitoUserClass({
        Username: email,
        Pool: userPool,
      });

      cognitoUser.authenticateUser(authenticationDetails, {
        onSuccess: (session: CognitoUserSession) => {
          // Get user attributes
          cognitoUser.getUserAttributes((err, attributes) => {
            if (err) {
              resolve({ error: { message: err.message } });
              return;
            }

            const user = extractUserData(session, attributes || [], email);

            resolve({ error: null, user });
          });
        },
        onFailure: (err) => {
          logger.error('Cognito sign-in error', { error: err });
          resolve({ error: { message: err.message, code: err.code } });
        },
        newPasswordRequired: (userAttributes) => {
          // For self-registered users, complete auth with the same password
          // This happens when Cognito puts users in FORCE_CHANGE_PASSWORD status
          logger.debug('Completing new password challenge with same password');

          // Filter out read-only Cognito attributes before completing challenge
          const writableAttributes = { ...userAttributes };
          delete writableAttributes.email;
          delete writableAttributes.email_verified;
          delete writableAttributes.phone_number;
          delete writableAttributes.phone_number_verified;

          cognitoUser.completeNewPasswordChallenge(password, writableAttributes, {
            onSuccess: (session: CognitoUserSession) => {
              // Successfully completed password challenge
              cognitoUser.getUserAttributes((err, attributes) => {
                if (err) {
                  resolve({ error: { message: err.message } });
                  return;
                }

                const user = extractUserData(session, attributes || [], email);

                resolve({ error: null, user });
              });
            },
            onFailure: (err) => {
              logger.error('New password challenge failed', { error: err });
              resolve({ error: { message: err.message, code: err.code } });
            },
          });
        },
      });
    });
  }

  // Sign out the current user.
  //
  // Invalidates the refresh token server-side via globalSignOut so a stolen
  // long-lived refresh token cannot be used after logout, then purges the
  // SDK's local token storage. On any globalSignOut failure (expired session,
  // network down) we fall back to the local-only signOut so logout always
  // completes locally — we never leave the user "logged in" because the
  // server call failed.
  //
  // Known limitation (CRITICAL #5, PARTIAL): amazon-cognito-identity-js@6.x
  // stores tokens in localStorage by default and supplying a custom in-memory
  // storage shim is invasive and SDK-constrained, so tokens still live in
  // JS-readable storage between login and logout. Moving the SDK off
  // localStorage is a deliberately out-of-scope residual.
  static async signOut(): Promise<void> {
    const cognitoUser = userPool.getCurrentUser();
    if (!cognitoUser) {
      // No active user, but stale Cognito keys may linger — purge them.
      purgeCognitoStorage();
      return;
    }

    return new Promise<void>((resolve) => {
      cognitoUser.globalSignOut({
        onSuccess: () => {
          purgeCognitoStorage();
          resolve();
        },
        onFailure: (err) => {
          logger.warn('Cognito globalSignOut failed; falling back to local sign-out', {
            error: err,
          });
          cognitoUser.signOut();
          purgeCognitoStorage();
          resolve();
        },
      });
    });
  }

  // Get current authenticated user
  static async getCurrentUser(): Promise<CognitoUserData | null> {
    return new Promise((resolve) => {
      const cognitoUser = userPool.getCurrentUser();

      if (!cognitoUser) {
        resolve(null);
        return;
      }

      cognitoUser.getSession((err: Error | null, session: CognitoUserSession) => {
        if (err || !session.isValid()) {
          resolve(null);
          return;
        }

        cognitoUser.getUserAttributes((err, attributes) => {
          if (err) {
            resolve(null);
            return;
          }

          const userAttributes: { [key: string]: string } = {};
          attributes?.forEach((attr) => {
            userAttributes[attr.getName()] = attr.getValue();
          });

          const user: CognitoUserData = {
            id: session.getIdToken().payload.sub,
            email: userAttributes.email ?? '',
            firstName: userAttributes.given_name,
            lastName: userAttributes.family_name,
            emailVerified: userAttributes.email_verified === 'true',
          };

          resolve(user);
        });
      });
    });
  }

  // Confirm user registration with verification code
  static async confirmSignUp(email: string, code: string): Promise<{ error: AuthError | null }> {
    return new Promise((resolve) => {
      const cognitoUser = new CognitoUserClass({
        Username: email,
        Pool: userPool,
      });

      cognitoUser.confirmRegistration(code, true, (err) => {
        if (err) {
          resolve({ error: { message: err.message } });
          return;
        }
        resolve({ error: null });
      });
    });
  }

  // Resend verification code
  static async resendConfirmationCode(email: string): Promise<{ error: AuthError | null }> {
    return new Promise((resolve) => {
      const cognitoUser = new CognitoUserClass({
        Username: email,
        Pool: userPool,
      });

      cognitoUser.resendConfirmationCode((err) => {
        if (err) {
          resolve({ error: { message: err.message } });
          return;
        }
        resolve({ error: null });
      });
    });
  }

  // Forgot password - initiate reset
  static async forgotPassword(email: string): Promise<{ error: AuthError | null }> {
    return new Promise((resolve) => {
      const cognitoUser = new CognitoUserClass({
        Username: email,
        Pool: userPool,
      });

      cognitoUser.forgotPassword({
        onSuccess: () => {
          resolve({ error: null });
        },
        onFailure: (err) => {
          resolve({ error: { message: err.message } });
        },
      });
    });
  }

  // Confirm forgot password with new password and code
  static async confirmPassword(
    email: string,
    code: string,
    newPassword: string
  ): Promise<{ error: AuthError | null }> {
    return new Promise((resolve) => {
      const cognitoUser = new CognitoUserClass({
        Username: email,
        Pool: userPool,
      });

      cognitoUser.confirmPassword(code, newPassword, {
        onSuccess: () => {
          resolve({ error: null });
        },
        onFailure: (err) => {
          resolve({ error: { message: err.message } });
        },
      });
    });
  }

  // Get current user's JWT token
  static async getCurrentUserToken(): Promise<string | null> {
    return new Promise((resolve) => {
      const cognitoUser = userPool.getCurrentUser();

      if (!cognitoUser) {
        resolve(null);
        return;
      }

      cognitoUser.getSession((err: Error | null, session: CognitoUserSession) => {
        if (err || !session.isValid()) {
          resolve(null);
          return;
        }

        // Return the ID token (JWT)
        resolve(session.getIdToken().getJwtToken());
      });
    });
  }

  // Get the bundle of values the Electron desktop agent needs to subscribe
  // to the cloud WebSocket on this user's behalf and refresh its id token
  // automatically. Returns null when no user is signed in or the session
  // is unrecoverable.
  static async getDesktopAgentTokens(): Promise<{
    idToken: string;
    refreshToken: string;
    cognitoClientId: string;
    region: string;
  } | null> {
    return new Promise((resolve) => {
      const cognitoUser = userPool.getCurrentUser();
      if (!cognitoUser) {
        resolve(null);
        return;
      }
      cognitoUser.getSession((err: Error | null, session: CognitoUserSession) => {
        if (err || !session.isValid()) {
          resolve(null);
          return;
        }
        const idToken = session.getIdToken().getJwtToken();
        const refreshToken = session.getRefreshToken().getToken();
        const clientId = cognitoConfig.userPoolWebClientId;
        const region = cognitoConfig.region;
        // Resolve null instead of pushing an incomplete bundle to the
        // desktop agent — the loopback POST validates these and 400s,
        // but failing fast here gives the UI a clearer signal.
        if (!idToken || !refreshToken || !clientId || !region) {
          resolve(null);
          return;
        }
        resolve({ idToken, refreshToken, cognitoClientId: clientId, region });
      });
    });
  }
}
