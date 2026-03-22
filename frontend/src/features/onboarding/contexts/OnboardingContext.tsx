import { createContext, useState, useRef, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { lambdaApiService } from '@/shared/services';
import { useUserProfile } from '@/features/profile';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ONBOARDING_STEPS = [
  'linkedin_credentials',
  'import_connections',
  'explore_network',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

export interface OnboardingContextType {
  currentStep: number;
  isOnboarding: boolean;
  completedSteps: Set<string>;
  isStepCompleted: (step: string) => boolean;
  completeStep: (step: string) => Promise<void>;
  skipStep: (step: string) => Promise<void>;
  completeOnboarding: () => Promise<void>;
  dismissOnboarding: () => void;
}

export const OnboardingContext = createContext<OnboardingContextType | undefined>(undefined);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const OnboardingProvider = ({ children }: { children: ReactNode }) => {
  const { userProfile } = useUserProfile();

  const [currentStep, setCurrentStep] = useState(0);
  const currentStepRef = useRef(0);
  const [isOnboarding, setIsOnboarding] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());

  // Determine onboarding state from user profile
  useEffect(() => {
    if (!userProfile) return;

    const profile = userProfile as Record<string, unknown>;
    if (profile.onboarding_completed) {
      setIsOnboarding(false);
      return;
    }

    // User has not completed onboarding
    setIsOnboarding(true);

    // Resume from last saved step
    const savedStep = profile.onboarding_step;
    if (typeof savedStep === 'number' && savedStep >= 0 && savedStep < ONBOARDING_STEPS.length) {
      currentStepRef.current = savedStep;
      setCurrentStep(savedStep);
    }
  }, [userProfile]);

  const emitStepEvent = useCallback(async (step: string, skipped: boolean) => {
    try {
      await lambdaApiService.apiClient.post('dynamodb', {
        operation: 'complete_onboarding_step',
        step,
        skipped,
      });
    } catch {
      // Fire-and-forget for event emission
    }
  }, []);

  const advanceStep = useCallback(() => {
    const next = currentStepRef.current + 1;
    currentStepRef.current = next;
    setCurrentStep(next);
    if (next >= ONBOARDING_STEPS.length) {
      // Final step completed -- persist completion so refresh does not re-show onboarding
      lambdaApiService.apiClient
        .post('dynamodb', {
          operation: 'complete_onboarding_step',
          step: 'completed',
          skipped: false,
        })
        .catch(() => {});
      lambdaApiService.apiClient
        .post('dynamodb', {
          operation: 'update_user_settings',
          onboarding_completed: true,
        })
        .catch(() => {});
      setIsOnboarding(false);
    } else {
      // Persist intermediate step progress (fire-and-forget)
      lambdaApiService.apiClient
        .post('dynamodb', {
          operation: 'update_user_settings',
          onboarding_step: next,
        })
        .catch(() => {});
    }
  }, []);

  const completeStep = useCallback(
    async (step: string) => {
      setCompletedSteps((prev) => new Set(prev).add(step));
      await emitStepEvent(step, false);
      advanceStep();
    },
    [emitStepEvent, advanceStep]
  );

  const skipStep = useCallback(
    async (step: string) => {
      setCompletedSteps((prev) => new Set(prev).add(step));
      await emitStepEvent(step, true);
      advanceStep();
    },
    [emitStepEvent, advanceStep]
  );

  const completeOnboarding = useCallback(async () => {
    try {
      await emitStepEvent('completed', false);
      await lambdaApiService.apiClient.post('dynamodb', {
        operation: 'update_user_settings',
        onboarding_completed: true,
      });
    } catch {
      // Best-effort persistence
    }
    setIsOnboarding(false);
  }, [emitStepEvent]);

  const dismissOnboarding = useCallback(() => {
    setIsOnboarding(false);
  }, []);

  const isStepCompleted = useCallback((step: string) => completedSteps.has(step), [completedSteps]);

  const value = useMemo<OnboardingContextType>(
    () => ({
      currentStep,
      isOnboarding,
      completedSteps,
      isStepCompleted,
      completeStep,
      skipStep,
      completeOnboarding,
      dismissOnboarding,
    }),
    [
      currentStep,
      isOnboarding,
      completedSteps,
      isStepCompleted,
      completeStep,
      skipStep,
      completeOnboarding,
      dismissOnboarding,
    ]
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
};
