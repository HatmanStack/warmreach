// src/contexts/UserProfileContext.tsx
import { createContext, useState, useContext, type ReactNode, useMemo, useEffect } from 'react';
import { profileApiService } from '@/shared/services/profileApiService';
import { useAuth } from '@/features/auth';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('UserProfileContext');

type LinkedInCredentialsCiphertext = string | null; // sealbox_x25519:b64:<...>

import type { UserProfile } from '@/types';

interface UserProfileContextType {
  // LinkedIn credentials
  ciphertext: LinkedInCredentialsCiphertext;
  setCiphertext: (ciphertext: LinkedInCredentialsCiphertext) => void;

  // General user profile
  userProfile: UserProfile | null;
  updateUserProfile: (updates: Partial<UserProfile>) => Promise<void>;
  refreshUserProfile: () => Promise<void>;

  // Loading states
  isLoading: boolean;
  // Surfaced fetch error so consumers can show a retry affordance. Null when
  // the last fetch succeeded or none has run yet.
  error: string | null;
}

const UserProfileContext = createContext<UserProfileContextType | undefined>(undefined);

// Bridge camelCase API responses to the snake_case shape the rest of
// the app reads (first_name/last_name, user_id, created_at, updated_at).
// Hoisted out of the component so it isn't recreated each render and
// can't accidentally end up in a hook dependency array.
// Accepts the typed `UserProfile` the API already returns and reads it through
// a single `Record<string, unknown>` view (a safe widening, not an `as unknown
// as` double-cast) so it can probe both casings without losing type safety.
function normalizeProfile(raw: UserProfile): UserProfile {
  const merged: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const aliases: Array<[string, string]> = [
    ['firstName', 'first_name'],
    ['lastName', 'last_name'],
    ['userId', 'user_id'],
    ['createdAt', 'created_at'],
    ['updatedAt', 'updated_at'],
  ];
  for (const [camel, snake] of aliases) {
    if (merged[snake] === undefined && merged[camel] !== undefined) {
      merged[snake] = merged[camel];
    }
    if (merged[camel] === undefined && merged[snake] !== undefined) {
      merged[camel] = merged[snake];
    }
  }
  return merged as UserProfile;
}

export const UserProfileProvider = ({ children }: { children: ReactNode }) => {
  const [ciphertext, setCiphertextState] = useState<LinkedInCredentialsCiphertext>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuth();

  // Avoid redundant fetches within a single session
  // This ensures we fetch once (e.g., from Dashboard) and reuse across the app
  // Using sessionStorage check instead of component variable to persist across renders

  // The API returns firstName/lastName in camelCase but every consumer in
  // the app reads first_name/last_name (snake_case). Without this bridge
  // the form falls back to placeholders and Dashboard's display name
  // collapses to email. Emit both casings so existing snake_case readers
  // keep working without a sweeping rename.
  // Fetch user profile from API
  const fetchUserProfile = async () => {
    if (!user) return;

    setIsLoading(true);
    setError(null);
    try {
      const response = await profileApiService.getUserProfile();
      logger.info('Profile fetch result', {
        success: response.success,
        hasData: !!response.data,
        error: response.error,
      });
      if (response.success && response.data) {
        setUserProfile(normalizeProfile(response.data));

        // Auto-detect timezone and save if not yet set or changed (ADR-008)
        try {
          const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const storedTimezone = response.data.timezone;
          if (detectedTimezone && detectedTimezone !== storedTimezone) {
            // Fire-and-forget: do not block profile fetch flow
            profileApiService
              .updateUserProfile({ timezone: detectedTimezone })
              .catch((err: unknown) => logger.warn('Failed to save timezone', { error: err }));
          }
        } catch {
          // Ignore timezone detection errors
        }

        // LinkedIn credentials live exclusively in the desktop client
        // (Sealbox-encrypted, on-device). The API no longer returns them
        // and the web context no longer hydrates them from any cloud
        // source.
        try {
          sessionStorage.setItem('profile_fetched', 'true');
        } catch {
          // Ignore storage errors
        }
      }
    } catch (err) {
      // Surface the failure and do NOT set the profile_fetched flag, so a
      // later mount or an explicit refreshUserProfile() retries the fetch
      // instead of being permanently suppressed for the session (HIGH #16).
      logger.error('Failed to fetch user profile', { error: err });
      setError(err instanceof Error ? err.message : 'Failed to fetch user profile');
    } finally {
      setIsLoading(false);
    }
  };

  // Update user profile
  const updateUserProfile = async (updates: Partial<UserProfile>) => {
    // Don't gate on AuthContext.user here — that state can lag behind a
    // valid Cognito session (initializeAuth runs once on mount and depends
    // on getUserAttributes resolving). The HTTP layer pulls the JWT fresh
    // from Cognito on every call, so let the save fire and surface a real
    // 401 if the session is actually gone.
    setIsLoading(true);
    try {
      const response = await profileApiService.updateUserProfile(updates);
      if (response.success) {
        // Refresh the profile to get updated data. fetchUserProfile owns
        // setting the profile_fetched flag on success — no redundant set here.
        await fetchUserProfile();
      } else {
        throw new Error(response.error || 'Failed to update profile');
      }
    } catch (error) {
      logger.error('Failed to update user profile', { error });
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  // Refresh user profile
  const refreshUserProfile = async () => {
    await fetchUserProfile();
  };

  // On mount, hydrate ciphertext from sessionStorage. Defer profile fetch to Dashboard,
  // but allow a guarded fetch if not fetched yet (for direct navigation fallbacks)
  useEffect(() => {
    // On logout (user becomes null), drop cached profile state and the
    // profile_fetched guard so the next login triggers a fresh fetch.
    // Without this, a re-login on the same tab keeps the stale profile and
    // skips the GET /profiles call, leaving DynamoDB-persisted state
    // (ai_generated_ideas, ai_generated_research, ai_synthesized_post)
    // invisible until a hard refresh.
    if (!user) {
      setUserProfile(null);
      setCiphertextState(null);
      try {
        sessionStorage.removeItem('profile_fetched');
        sessionStorage.removeItem('li_credentials_ciphertext');
      } catch {
        // Ignore storage errors
      }
      return;
    }

    try {
      const stored = sessionStorage.getItem('li_credentials_ciphertext');
      logger.debug('Loading credentials from sessionStorage', {
        hasStored: !!stored,
        startsWithPrefix: stored ? stored.startsWith('sealbox_x25519:b64:') : false,
        length: stored ? stored.length : 0,
      });
      if (stored && stored.startsWith('sealbox_x25519:b64:')) {
        setCiphertextState(stored);
        logger.debug('Credentials loaded successfully');
      } else {
        logger.warn('No valid credentials found in sessionStorage');
      }
    } catch (err) {
      logger.error('Error loading credentials', { error: err });
    }

    const alreadyFetched = (() => {
      try {
        return sessionStorage.getItem('profile_fetched') === 'true';
      } catch {
        return false;
      }
    })();
    if (!alreadyFetched) {
      // Guarded fetch for non-dashboard entry points. The profile_fetched
      // flag is set ONLY after a successful fetch (in fetchUserProfile), so a
      // failed fetch leaves the guard open and a later mount/retry re-attempts
      // (HIGH #16).
      fetchUserProfile();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Memoize the context value to prevent unnecessary re-renders
  const contextValue = useMemo(
    () => ({
      ciphertext,
      setCiphertext: (value: LinkedInCredentialsCiphertext) => {
        logger.debug('setCiphertext called', {
          hasValue: !!value,
          startsWithPrefix: value ? value.startsWith('sealbox_x25519:b64:') : false,
        });
        setCiphertextState(value);
        try {
          if (value && value.startsWith('sealbox_x25519:b64:')) {
            sessionStorage.setItem('li_credentials_ciphertext', value);
            logger.debug('Credentials saved to sessionStorage');
          } else {
            sessionStorage.removeItem('li_credentials_ciphertext');
            logger.debug('Credentials removed from sessionStorage');
          }
        } catch {
          // Ignore storage errors
        }
      },
      userProfile,
      updateUserProfile,
      refreshUserProfile,
      isLoading,
      error,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ciphertext, userProfile, isLoading, error]
  );

  return <UserProfileContext.Provider value={contextValue}>{children}</UserProfileContext.Provider>;
};

export const useUserProfile = () => {
  const context = useContext(UserProfileContext);
  if (context === undefined) {
    throw new Error('useUserProfile must be used within a UserProfileProvider');
  }
  return context;
};
