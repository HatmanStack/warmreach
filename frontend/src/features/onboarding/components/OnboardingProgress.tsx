import { ONBOARDING_STEPS } from '../contexts/OnboardingContext';
import { useOnboarding } from '../hooks/useOnboarding';

const STEP_LABELS: Record<string, string> = {
  linkedin_credentials: 'Connect',
  import_connections: 'Import',
  explore_network: 'Explore',
  tier_comparison: 'Plans',
};

export const OnboardingProgress = () => {
  const { currentStep, isStepCompleted } = useOnboarding();

  return (
    <div className="flex items-center justify-center gap-2 py-4" data-testid="onboarding-progress">
      {ONBOARDING_STEPS.map((step, index) => {
        const completed = isStepCompleted(step);
        const isCurrent = index === currentStep;

        return (
          <div key={step} className="flex items-center">
            {index > 0 && (
              <div className={`h-0.5 w-8 mx-1 ${completed ? 'bg-primary' : 'bg-muted'}`} />
            )}
            <div className="flex flex-col items-center gap-1">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium transition-colors ${
                  completed
                    ? 'bg-primary text-primary-foreground'
                    : isCurrent
                      ? 'border-2 border-primary text-primary'
                      : 'border-2 border-muted text-muted-foreground'
                }`}
              >
                {completed ? '\u2713' : index + 1}
              </div>
              <span
                className={`text-xs ${
                  isCurrent ? 'text-primary font-medium' : 'text-muted-foreground'
                }`}
              >
                {STEP_LABELS[step]}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
