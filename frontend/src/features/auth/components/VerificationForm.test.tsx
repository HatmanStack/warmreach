import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VerificationForm } from './VerificationForm';

describe('VerificationForm', () => {
  const defaultProps = {
    verificationEmail: 'test@example.com',
    verificationData: { code: '' },
    onVerificationDataChange: vi.fn(),
    onSubmit: vi.fn(),
    onResend: vi.fn(),
    onBack: vi.fn(),
    isLoading: false,
  };

  it('renders verification code input', () => {
    render(<VerificationForm {...defaultProps} />);
    expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
  });

  it('displays the verification email', () => {
    render(<VerificationForm {...defaultProps} />);
    expect(screen.getByText('test@example.com')).toBeInTheDocument();
  });

  it('renders verify and resend buttons', () => {
    render(<VerificationForm {...defaultProps} />);
    expect(screen.getByText('Verify Email')).toBeInTheDocument();
    expect(screen.getByText('Resend Code')).toBeInTheDocument();
  });

  it('disables verify button when code is not 6 digits', () => {
    render(<VerificationForm {...defaultProps} verificationData={{ code: '123' }} />);
    const verifyBtn = screen.getByText('Verify Email');
    expect(verifyBtn).toBeDisabled();
  });

  it('enables verify button when code is 6 digits', () => {
    render(<VerificationForm {...defaultProps} verificationData={{ code: '123456' }} />);
    const verifyBtn = screen.getByText('Verify Email');
    expect(verifyBtn).not.toBeDisabled();
  });

  it('calls onBack when back button is clicked', () => {
    const onBack = vi.fn();
    render(<VerificationForm {...defaultProps} onBack={onBack} />);
    fireEvent.click(screen.getByText('Back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('calls onResend when resend button is clicked', () => {
    const onResend = vi.fn();
    render(<VerificationForm {...defaultProps} onResend={onResend} />);
    fireEvent.click(screen.getByText('Resend Code'));
    expect(onResend).toHaveBeenCalled();
  });

  it('shows loading state', () => {
    render(<VerificationForm {...defaultProps} isLoading={true} />);
    expect(screen.getByText('Verifying...')).toBeInTheDocument();
  });
});
