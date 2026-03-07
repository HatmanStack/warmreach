import { render, screen, fireEvent } from '@testing-library/react';
import { MessageModal } from '../MessageModal';
import { buildConnection, createAuthenticatedWrapper } from '@/test-utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock useToneAnalysis
vi.mock('@/features/connections/hooks/useToneAnalysis', () => ({
  useToneAnalysis: () => ({
    result: null,
    isAnalyzing: false,
    analyzeTone: vi.fn(),
    clearResult: vi.fn(),
  }),
}));

describe('MessageModal', () => {
  const mockConnection = buildConnection({
    id: 'c1',
    first_name: 'John',
    last_name: 'Doe',
    message_history: [
      { id: 'm1', content: 'Hi', timestamp: '2024-01-01T10:00:00.000Z', sender: 'connection' },
    ],
  });

  const AuthenticatedWrapper = createAuthenticatedWrapper();

  const defaultProps = {
    isOpen: true,
    connection: mockConnection,
    onClose: vi.fn(),
    onSendMessage: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render connection name and messages', () => {
    render(
      <AuthenticatedWrapper>
        <MessageModal {...defaultProps} />
      </AuthenticatedWrapper>
    );

    expect(screen.getByText('John Doe')).toBeInTheDocument();
    expect(screen.getByText('Hi')).toBeInTheDocument();
  });

  it('should call onSendMessage when send button is clicked', async () => {
    render(
      <AuthenticatedWrapper>
        <MessageModal {...defaultProps} />
      </AuthenticatedWrapper>
    );

    const textarea = screen.getByPlaceholderText(/type your message/i);
    fireEvent.change(textarea, { target: { value: 'Hello back' } });

    const sendBtn = screen.getByLabelText(/send message/i);
    fireEvent.click(sendBtn);

    expect(defaultProps.onSendMessage).toHaveBeenCalledWith('Hello back');
  });

  it('should handle pre-populated message', () => {
    render(
      <AuthenticatedWrapper>
        <MessageModal {...defaultProps} prePopulatedMessage="AI generated content" />
      </AuthenticatedWrapper>
    );

    const textarea = screen.getByPlaceholderText(/type your message/i);
    expect(textarea).toHaveValue('AI generated content');
  });

  it('should show generation controls when showGenerationControls is true', () => {
    render(
      <AuthenticatedWrapper>
        <MessageModal {...defaultProps} showGenerationControls={true} onApproveAndNext={vi.fn()} />
      </AuthenticatedWrapper>
    );

    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /skip/i })).toBeInTheDocument();
  });

  it('should handle keyboard shortcuts', () => {
    const mockApprove = vi.fn();
    render(
      <AuthenticatedWrapper>
        <MessageModal
          {...defaultProps}
          showGenerationControls={true}
          onApproveAndNext={mockApprove}
        />
      </AuthenticatedWrapper>
    );

    fireEvent.keyDown(document, { key: 'Enter', ctrlKey: true });
    expect(mockApprove).toHaveBeenCalled();
  });

  it('should show error state', () => {
    render(
      <AuthenticatedWrapper>
        <MessageModal {...defaultProps} messagesError="Failed to load" />
      </AuthenticatedWrapper>
    );

    expect(screen.getByText('Failed to load')).toBeInTheDocument();
  });
});
