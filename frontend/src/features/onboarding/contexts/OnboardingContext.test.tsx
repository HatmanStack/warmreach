import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OnboardingProvider, type OnboardingContextType } from './OnboardingContext';
import { useOnboarding } from '../hooks/useOnboarding';

// Mock lambdaApiService
const mockPost = vi.fn().mockResolvedValue({ data: {} });
vi.mock('@/shared/services', () => ({
  lambdaApiService: {
    apiClient: { post: (...args: unknown[]) => mockPost(...args) },
  },
}));

// Mock useUserProfile
const mockUserProfile = vi.fn();
vi.mock('@/features/profile', () => ({
  useUserProfile: () => mockUserProfile(),
}));

// Helper to render and expose context value
function TestConsumer({ onRender }: { onRender: (ctx: OnboardingContextType) => void }) {
  const ctx = useOnboarding();
  onRender(ctx);
  return (
    <div>
      <span data-testid="isOnboarding">{ctx.isOnboarding ? 'yes' : 'no'}</span>
      <span data-testid="currentStep">{ctx.currentStep}</span>
    </div>
  );
}

describe('OnboardingContext', () => {
  let captured: OnboardingContextType;

  const renderWithProvider = () => {
    return render(
      <OnboardingProvider>
        <TestConsumer
          onRender={(ctx) => {
            captured = ctx;
          }}
        />
      </OnboardingProvider>
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockResolvedValue({ data: {} });
  });

  it('sets isOnboarding to false when onboarding_completed is true', async () => {
    mockUserProfile.mockReturnValue({
      userProfile: { onboarding_completed: true },
    });

    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByTestId('isOnboarding')).toHaveTextContent('no');
    });
  });

  it('sets isOnboarding to true when onboarding_completed is missing', async () => {
    mockUserProfile.mockReturnValue({
      userProfile: { first_name: 'Test' },
    });

    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByTestId('isOnboarding')).toHaveTextContent('yes');
    });
  });

  it('sets isOnboarding to false when userProfile is null (loading)', () => {
    mockUserProfile.mockReturnValue({ userProfile: null });

    renderWithProvider();

    // Default state is false (no onboarding while loading)
    expect(screen.getByTestId('isOnboarding')).toHaveTextContent('no');
  });

  it('completeStep calls API with correct operation and advances step', async () => {
    mockUserProfile.mockReturnValue({
      userProfile: { first_name: 'Test' },
    });

    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByTestId('isOnboarding')).toHaveTextContent('yes');
    });

    await act(async () => {
      await captured.completeStep('linkedin_credentials');
    });

    // Should have called complete_onboarding_step event
    expect(mockPost).toHaveBeenCalledWith(
      'dynamodb',
      expect.objectContaining({
        operation: 'complete_onboarding_step',
        step: 'linkedin_credentials',
        skipped: false,
      })
    );

    // Step should have advanced
    expect(screen.getByTestId('currentStep')).toHaveTextContent('1');
  });

  it('skipStep calls API with skipped: true', async () => {
    mockUserProfile.mockReturnValue({
      userProfile: { first_name: 'Test' },
    });

    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByTestId('isOnboarding')).toHaveTextContent('yes');
    });

    await act(async () => {
      await captured.skipStep('import_connections');
    });

    expect(mockPost).toHaveBeenCalledWith(
      'dynamodb',
      expect.objectContaining({
        operation: 'complete_onboarding_step',
        step: 'import_connections',
        skipped: true,
      })
    );
  });

  it('completeOnboarding calls update_user_settings with onboarding_completed', async () => {
    mockUserProfile.mockReturnValue({
      userProfile: { first_name: 'Test' },
    });

    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByTestId('isOnboarding')).toHaveTextContent('yes');
    });

    await act(async () => {
      await captured.completeOnboarding();
    });

    expect(mockPost).toHaveBeenCalledWith(
      'dynamodb',
      expect.objectContaining({
        operation: 'update_user_settings',
        onboarding_completed: true,
      })
    );

    expect(screen.getByTestId('isOnboarding')).toHaveTextContent('no');
  });

  it('resumes from saved onboarding_step', async () => {
    mockUserProfile.mockReturnValue({
      userProfile: { onboarding_step: 2 },
    });

    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByTestId('currentStep')).toHaveTextContent('2');
    });
  });

  it('completing the final step (explore_network) auto-persists onboarding_completed', async () => {
    // Start at step 2 -- explore_network is the last step in community edition (3 steps total)
    mockUserProfile.mockReturnValue({
      userProfile: { onboarding_step: 2 },
    });

    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByTestId('currentStep')).toHaveTextContent('2');
    });

    await act(async () => {
      await captured.completeStep('explore_network');
    });

    // Must have persisted onboarding_completed: true -- no manual completeOnboarding() call needed
    expect(mockPost).toHaveBeenCalledWith(
      'dynamodb',
      expect.objectContaining({
        operation: 'update_user_settings',
        onboarding_completed: true,
      })
    );

    // Overlay must be hidden permanently after page refresh
    expect(screen.getByTestId('isOnboarding')).toHaveTextContent('no');
  });

  it('skipping the final step (explore_network) also auto-persists onboarding_completed', async () => {
    mockUserProfile.mockReturnValue({
      userProfile: { onboarding_step: 2 },
    });

    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByTestId('currentStep')).toHaveTextContent('2');
    });

    await act(async () => {
      await captured.skipStep('explore_network');
    });

    expect(mockPost).toHaveBeenCalledWith(
      'dynamodb',
      expect.objectContaining({
        operation: 'update_user_settings',
        onboarding_completed: true,
      })
    );

    expect(screen.getByTestId('isOnboarding')).toHaveTextContent('no');
  });
});
