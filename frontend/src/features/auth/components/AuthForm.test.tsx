import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthForm } from './AuthForm';

describe('AuthForm', () => {
  const defaultProps = {
    signInData: { email: '', password: '' },
    onSignInDataChange: vi.fn(),
    onSignIn: vi.fn(),
    signUpData: { email: '', password: '', firstName: '', lastName: '' },
    onSignUpDataChange: vi.fn(),
    onSignUp: vi.fn(),
    showPassword: false,
    onTogglePassword: vi.fn(),
    isLoading: false,
    isPreloading: false,
    onPreload: vi.fn(),
  };

  it('renders Sign In and Sign Up tabs', () => {
    render(<AuthForm {...defaultProps} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent('Sign In');
    expect(tabs[1]).toHaveTextContent('Sign Up');
  });

  it('defaults to sign in tab', () => {
    render(<AuthForm {...defaultProps} />);
    expect(screen.getByTestId('sign-in-button')).toBeInTheDocument();
  });

  it('sign in tab is active by default', () => {
    render(<AuthForm {...defaultProps} />);
    const signInTab = screen.getByRole('tab', { name: 'Sign In' });
    expect(signInTab).toHaveAttribute('data-state', 'active');
  });

  describe('accessible names', () => {
    it('names the password visibility toggle for its current state', () => {
      const { rerender } = render(<AuthForm {...defaultProps} showPassword={false} />);
      // Queried by role + accessible name on purpose: this fails if the
      // aria-label is dropped, which a getByTestId query would not notice.
      expect(screen.getByRole('button', { name: 'Show password' })).toBeInTheDocument();

      rerender(<AuthForm {...defaultProps} showPassword={true} />);
      expect(screen.getByRole('button', { name: 'Hide password' })).toBeInTheDocument();
    });

    it('labels both sign-in fields', () => {
      render(<AuthForm {...defaultProps} />);
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
    });
  });
});
