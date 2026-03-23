import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProfileForm } from './ProfileForm';
import type { ProfileData } from '../hooks/useProfileForm';

const defaultProfile: ProfileData = {
  name: 'Jane Doe',
  title: 'Engineer',
  company: 'Acme',
  location: 'NYC',
  bio: 'A bio',
  interests: [],
  linkedinUrl: 'https://linkedin.com/in/jane',
};

describe('ProfileForm', () => {
  it('renders all input fields', () => {
    render(<ProfileForm profile={defaultProfile} onInputChange={vi.fn()} />);
    expect(screen.getByLabelText('Full Name')).toHaveValue('Jane Doe');
    expect(screen.getByLabelText('Job Title')).toHaveValue('Engineer');
    expect(screen.getByLabelText('Company')).toHaveValue('Acme');
    expect(screen.getByLabelText('Location')).toHaveValue('NYC');
    expect(screen.getByLabelText('Professional Bio')).toHaveValue('A bio');
    expect(screen.getByLabelText('LinkedIn Profile URL')).toHaveValue(
      'https://linkedin.com/in/jane'
    );
  });

  it('calls onInputChange when name is changed', () => {
    const onInputChange = vi.fn();
    render(<ProfileForm profile={defaultProfile} onInputChange={onInputChange} />);
    fireEvent.change(screen.getByLabelText('Full Name'), { target: { value: 'John' } });
    expect(onInputChange).toHaveBeenCalledWith('name', 'John');
  });

  it('renders the Basic Information heading', () => {
    render(<ProfileForm profile={defaultProfile} onInputChange={vi.fn()} />);
    expect(screen.getByText('Basic Information')).toBeInTheDocument();
  });
});
