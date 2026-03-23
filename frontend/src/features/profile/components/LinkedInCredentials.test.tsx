import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LinkedInCredentials } from './LinkedInCredentials';

describe('LinkedInCredentials', () => {
  const defaultProps = {
    credentials: { email: '', password: '' },
    showPassword: false,
    hasStoredCredentials: false,
    onCredentialsChange: vi.fn(),
    onTogglePassword: vi.fn(),
  };

  it('renders email and password fields', () => {
    render(<LinkedInCredentials {...defaultProps} />);
    expect(screen.getByLabelText('LinkedIn Email')).toBeInTheDocument();
    expect(screen.getByLabelText('LinkedIn Password')).toBeInTheDocument();
  });

  it('shows stored credentials banner when hasStoredCredentials is true', () => {
    render(<LinkedInCredentials {...defaultProps} hasStoredCredentials={true} />);
    expect(screen.getByText(/Credentials are securely stored/)).toBeInTheDocument();
  });

  it('does not show stored credentials banner when hasStoredCredentials is false', () => {
    render(<LinkedInCredentials {...defaultProps} />);
    expect(screen.queryByText(/Credentials are securely stored/)).not.toBeInTheDocument();
  });

  it('calls onCredentialsChange when email is changed', () => {
    const onCredentialsChange = vi.fn();
    render(<LinkedInCredentials {...defaultProps} onCredentialsChange={onCredentialsChange} />);
    fireEvent.change(screen.getByLabelText('LinkedIn Email'), {
      target: { value: 'test@example.com' },
    });
    expect(onCredentialsChange).toHaveBeenCalledWith('email', 'test@example.com');
  });

  it('calls onTogglePassword when visibility button is clicked', () => {
    const onTogglePassword = vi.fn();
    render(<LinkedInCredentials {...defaultProps} onTogglePassword={onTogglePassword} />);
    // The toggle button is within the password field area
    const toggleButtons = screen.getAllByRole('button');
    // The toggle password button is the only button
    fireEvent.click(toggleButtons[0]);
    expect(onTogglePassword).toHaveBeenCalled();
  });

  it('renders security note', () => {
    render(<LinkedInCredentials {...defaultProps} />);
    expect(screen.getByText(/Security Note/)).toBeInTheDocument();
  });
});
