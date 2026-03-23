import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SignInForm } from './SignInForm';

describe('SignInForm', () => {
  const defaultProps = {
    signInData: { email: '', password: '' },
    onSignInDataChange: vi.fn(),
    onSubmit: vi.fn(),
    showPassword: false,
    onTogglePassword: vi.fn(),
    isLoading: false,
    isPreloading: false,
    onPreload: vi.fn(),
  };

  it('renders email and password fields', () => {
    render(<SignInForm {...defaultProps} />);
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('renders sign in button', () => {
    render(<SignInForm {...defaultProps} />);
    expect(screen.getByTestId('sign-in-button')).toBeInTheDocument();
    expect(screen.getByTestId('sign-in-button')).toHaveTextContent('Sign In');
  });

  it('shows loading state', () => {
    render(<SignInForm {...defaultProps} isLoading={true} />);
    expect(screen.getByTestId('sign-in-button')).toHaveTextContent('Signing In...');
  });

  it('calls onSubmit when form is submitted', () => {
    const onSubmit = vi.fn((e) => e.preventDefault());
    render(<SignInForm {...defaultProps} onSubmit={onSubmit} />);
    fireEvent.submit(screen.getByTestId('sign-in-button').closest('form')!);
    expect(onSubmit).toHaveBeenCalled();
  });

  it('calls onTogglePassword when visibility button is clicked', () => {
    const onTogglePassword = vi.fn();
    render(<SignInForm {...defaultProps} onTogglePassword={onTogglePassword} />);
    // Find the visibility toggle button (not the submit button)
    const buttons = screen.getAllByRole('button');
    const toggleBtn = buttons.find((btn) => btn.getAttribute('type') === 'button');
    if (toggleBtn) fireEvent.click(toggleBtn);
    expect(onTogglePassword).toHaveBeenCalled();
  });

  it('disables inputs when loading', () => {
    render(<SignInForm {...defaultProps} isLoading={true} />);
    expect(screen.getByTestId('email-input')).toBeDisabled();
    expect(screen.getByTestId('password-input')).toBeDisabled();
  });
});
