import { useOnboarding } from '../hooks/useOnboarding';
import { OnboardingProgress } from './OnboardingProgress';
import { LinkedInCredentialStep } from './LinkedInCredentialStep';
import { ImportConnectionsStep } from './ImportConnectionsStep';
import { ExploreNetworkStep } from './ExploreNetworkStep';

const STEP_COMPONENTS = [LinkedInCredentialStep, ImportConnectionsStep, ExploreNetworkStep];

export const OnboardingOverlay = () => {
  const { isOnboarding, currentStep } = useOnboarding();

  // Dev pause: set VITE_DISABLE_ONBOARDING=true in the frontend .env to
  // suppress the onboarding overlay while developing. Defaults to showing
  // onboarding, so production builds are unaffected.
  if (import.meta.env.VITE_DISABLE_ONBOARDING === 'true') return null;

  if (!isOnboarding) return null;

  const StepComponent = STEP_COMPONENTS[currentStep];
  if (!StepComponent) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      data-testid="onboarding-overlay"
    >
      <div className="bg-background rounded-xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-6 space-y-4">
        <OnboardingProgress />
        <StepComponent />
      </div>
    </div>
  );
};
