import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MessageModal } from './MessageModal';
import type { Connection } from '@/types';

// Mock cognito service to prevent UserPool init error
vi.mock('@/features/auth/services/cognitoService', () => ({
  default: {
    signIn: vi.fn(),
    signOut: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));

vi.mock('@/features/auth', () => ({
  useAuth: () => ({ user: null, isAuthenticated: false, signIn: vi.fn(), signOut: vi.fn() }),
}));

// Mock shared hooks
vi.mock('@/shared/hooks', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Mock tier context
vi.mock('@/features/tier', () => ({
  useTier: () => ({ isFeatureEnabled: () => false, tier: 'community', loading: false }),
  FeatureGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock tone analysis hook
vi.mock('@/features/connections/hooks/useToneAnalysis', () => ({
  useToneAnalysis: () => ({
    result: null,
    isAnalyzing: false,
    error: null,
    analyzeTone: vi.fn(),
    clearResult: vi.fn(),
  }),
}));

// Mock logger
vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockConnection: Connection = {
  id: 'test-id',
  first_name: 'John',
  last_name: 'Smith',
  position: 'Product Manager',
  company: 'TechCo',
  status: 'ally',
  message_history: [
    {
      id: 'msg-1',
      content: 'Hello John!',
      timestamp: '2024-01-15T10:00:00Z',
      sender: 'user',
    },
    {
      id: 'msg-2',
      content: 'Hey! Nice to hear from you.',
      timestamp: '2024-01-15T10:05:00Z',
      sender: 'connection',
    },
  ],
};

describe('MessageModal', () => {
  const defaultProps = {
    isOpen: true,
    connection: mockConnection,
    onClose: vi.fn(),
  };

  it('should render connection name in title', () => {
    render(<MessageModal {...defaultProps} />);

    expect(screen.getByText(/john smith/i)).toBeInTheDocument();
  });

  it('should render connection position and company', () => {
    render(<MessageModal {...defaultProps} />);

    expect(screen.getByText('Product Manager at TechCo')).toBeInTheDocument();
  });

  it('should render message history', () => {
    render(<MessageModal {...defaultProps} />);

    expect(screen.getByText('Hello John!')).toBeInTheDocument();
    expect(screen.getByText('Hey! Nice to hear from you.')).toBeInTheDocument();
  });

  it('should show empty state when no messages', () => {
    render(
      <MessageModal {...defaultProps} connection={{ ...mockConnection, message_history: [] }} />
    );

    expect(screen.queryByText('Hello John!')).not.toBeInTheDocument();
  });

  it('should show error state when messagesError is set', () => {
    render(<MessageModal {...defaultProps} messagesError="Failed to load" />);

    expect(screen.getByText('Failed to Load Messages')).toBeInTheDocument();
    expect(screen.getByText('Failed to load')).toBeInTheDocument();
  });

  it('should show retry button when error and onRetryLoadMessages provided', () => {
    const onRetry = vi.fn();
    render(
      <MessageModal {...defaultProps} messagesError="Network error" onRetryLoadMessages={onRetry} />
    );

    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('should show AI Generated badge when isGeneratedContent is true', () => {
    render(<MessageModal {...defaultProps} isGeneratedContent={true} />);

    expect(screen.getByText('AI Generated')).toBeInTheDocument();
  });

  it('should render send button', () => {
    render(<MessageModal {...defaultProps} />);

    expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument();
  });

  it('should show generation controls when showGenerationControls is true', () => {
    render(
      <MessageModal
        {...defaultProps}
        showGenerationControls={true}
        onApproveAndNext={vi.fn()}
        onSkipConnection={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /skip/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });

  it('should not render when isOpen is false', () => {
    render(<MessageModal {...defaultProps} isOpen={false} />);

    expect(screen.queryByText(/john smith/i)).not.toBeInTheDocument();
  });
});
