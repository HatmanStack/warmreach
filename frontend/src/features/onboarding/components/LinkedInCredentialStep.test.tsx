import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { LinkedInCredentialStep } from './LinkedInCredentialStep';

// Mock useOnboarding
const mockCompleteStep = vi.fn().mockResolvedValue(undefined);
vi.mock('../hooks/useOnboarding', () => ({
  useOnboarding: () => ({
    completeStep: mockCompleteStep,
    currentStep: 0,
    isOnboarding: true,
  }),
}));

// Mock crypto
vi.mock('@/shared/utils/crypto', () => ({
  encryptWithSealboxB64: vi.fn().mockResolvedValue('encrypted-data'),
}));

// Profile mock state
let mockCiphertext: string | null = null;
vi.mock('@/features/profile', () => ({
  useUserProfile: () => ({
    ciphertext: mockCiphertext,
    setCiphertext: vi.fn(),
    updateUserProfile: vi.fn().mockResolvedValue(undefined),
    userProfile: null,
    refreshUserProfile: vi.fn(),
    isLoading: false,
  }),
}));

describe('LinkedInCredentialStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCiphertext = null;
  });

  it('continue button is disabled when no credentials are present', () => {
    render(
      <MemoryRouter>
        <LinkedInCredentialStep />
      </MemoryRouter>
    );

    const continueButton = screen.getByTestId('onboarding-continue');
    expect(continueButton).toBeDisabled();
  });

  it('continue button is enabled when credentials are already stored', () => {
    mockCiphertext = 'sealbox_x25519:b64:abc123';

    render(
      <MemoryRouter>
        <LinkedInCredentialStep />
      </MemoryRouter>
    );

    const continueButton = screen.getByTestId('onboarding-continue');
    expect(continueButton).not.toBeDisabled();
  });

  it('shows stored credentials message when ciphertext exists', () => {
    mockCiphertext = 'sealbox_x25519:b64:abc123';

    render(
      <MemoryRouter>
        <LinkedInCredentialStep />
      </MemoryRouter>
    );

    expect(screen.getByText('LinkedIn credentials are securely stored.')).toBeInTheDocument();
  });

  it('shows the credential form when no ciphertext', () => {
    render(
      <MemoryRouter>
        <LinkedInCredentialStep />
      </MemoryRouter>
    );

    expect(screen.getByLabelText('LinkedIn Email')).toBeInTheDocument();
    expect(screen.getByLabelText('LinkedIn Password')).toBeInTheDocument();
  });
});
