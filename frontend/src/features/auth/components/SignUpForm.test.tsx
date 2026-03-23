import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SignUpForm } from './SignUpForm';

describe('SignUpForm', () => {
  const defaultProps = {
    signUpData: { email: '', password: '', firstName: '', lastName: '' },
    onSignUpDataChange: vi.fn(),
    onSubmit: vi.fn(),
    showPassword: false,
    onTogglePassword: vi.fn(),
    isLoading: false,
  };

  it('renders all form fields', () => {
    render(<SignUpForm {...defaultProps} />);
    expect(screen.getByLabelText('First Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Last Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('renders create account button', () => {
    render(<SignUpForm {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Create Account' })).toBeInTheDocument();
  });

  it('shows loading state', () => {
    render(<SignUpForm {...defaultProps} isLoading={true} />);
    expect(screen.getByText('Creating Account...')).toBeInTheDocument();
  });

  it('renders heading and description', () => {
    render(<SignUpForm {...defaultProps} />);
    expect(screen.getByText('Create a new account to get started')).toBeInTheDocument();
  });
});
