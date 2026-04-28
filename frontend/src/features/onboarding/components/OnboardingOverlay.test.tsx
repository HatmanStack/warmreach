import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OnboardingOverlay } from './OnboardingOverlay';

// Mock useOnboarding
const mockCompleteStep = vi.fn().mockResolvedValue(undefined);
const mockSkipStep = vi.fn().mockResolvedValue(undefined);
const mockCompleteOnboarding = vi.fn().mockResolvedValue(undefined);
const mockDismissOnboarding = vi.fn();

const defaultOnboarding = {
  currentStep: 0,
  isOnboarding: true,
  completedSteps: new Set<string>(),
  isStepCompleted: vi.fn().mockReturnValue(false),
  completeStep: mockCompleteStep,
  skipStep: mockSkipStep,
  completeOnboarding: mockCompleteOnboarding,
  dismissOnboarding: mockDismissOnboarding,
};

let mockOnboardingValue = { ...defaultOnboarding };

vi.mock('../hooks/useOnboarding', () => ({
  useOnboarding: () => mockOnboardingValue,
}));

// Mock useUserProfile for LinkedInCredentialStep
vi.mock('@/features/profile', () => ({
  useUserProfile: () => ({
    ciphertext: null,
    setCiphertext: vi.fn(),
    updateUserProfile: vi.fn().mockResolvedValue(undefined),
    userProfile: null,
    refreshUserProfile: vi.fn(),
    isLoading: false,
  }),
}));

// Mock crypto utility
vi.mock('@/shared/utils/crypto', () => ({
  encryptWithSealboxB64: vi.fn().mockResolvedValue('encrypted-data'),
}));

const renderOverlay = () => {
  // OnboardingOverlay → LinkedInCredentialStep → DesktopClientDownloadPrompt
  // uses useQuery to fetch /client-downloads, so a QueryClientProvider is
  // required at the test root.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <OnboardingOverlay />
      </MemoryRouter>
    </QueryClientProvider>
  );
};

describe('OnboardingOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOnboardingValue = { ...defaultOnboarding };
  });

  it('renders nothing when isOnboarding is false', () => {
    mockOnboardingValue = { ...defaultOnboarding, isOnboarding: false };
    const { container } = renderOverlay();
    expect(container.firstChild).toBeNull();
  });

  it('renders the overlay when isOnboarding is true', () => {
    renderOverlay();
    expect(screen.getByTestId('onboarding-overlay')).toBeInTheDocument();
  });

  it('renders LinkedInCredentialStep when currentStep is 0', () => {
    mockOnboardingValue = { ...defaultOnboarding, currentStep: 0 };
    renderOverlay();
    expect(screen.getByText('Connect your LinkedIn account')).toBeInTheDocument();
  });

  it('renders ImportConnectionsStep when currentStep is 1', () => {
    mockOnboardingValue = { ...defaultOnboarding, currentStep: 1 };
    renderOverlay();
    expect(screen.getByText('Import Your Connections')).toBeInTheDocument();
  });

  it('renders ExploreNetworkStep when currentStep is 2', () => {
    mockOnboardingValue = { ...defaultOnboarding, currentStep: 2 };
    renderOverlay();
    expect(screen.getByText('Explore Your Network')).toBeInTheDocument();
  });

  it('renders nothing for out-of-bounds step', () => {
    // Community edition has 3 steps; TierComparisonStep is Pro-only.
    mockOnboardingValue = { ...defaultOnboarding, currentStep: 3 };
    const { container } = renderOverlay();
    expect(container.firstChild).toBeNull();
  });

  it('skip button on ImportConnectionsStep calls skipStep', async () => {
    mockOnboardingValue = { ...defaultOnboarding, currentStep: 1 };
    renderOverlay();

    const skipButton = screen.getByTestId('onboarding-skip');
    fireEvent.click(skipButton);

    await waitFor(() => {
      expect(mockSkipStep).toHaveBeenCalledWith('import_connections');
    });
  });

  it('progress indicator is visible', () => {
    renderOverlay();
    expect(screen.getByTestId('onboarding-progress')).toBeInTheDocument();
  });
});
