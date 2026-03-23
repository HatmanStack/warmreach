import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProfilePreview } from './ProfilePreview';
import type { ProfileData } from '../hooks/useProfileForm';

const defaultProfile: ProfileData = {
  name: 'Jane Doe',
  title: 'Engineer',
  company: 'Acme',
  location: 'NYC',
  bio: 'A test bio',
  interests: ['React', 'Go'],
  linkedinUrl: 'https://linkedin.com/in/jane',
};

describe('ProfilePreview', () => {
  it('renders the profile name and title', () => {
    render(
      <ProfilePreview
        profile={defaultProfile}
        hasStoredCredentials={false}
        linkedinCredentials={{ email: '', password: '' }}
      />
    );
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('Engineer')).toBeInTheDocument();
  });

  it('renders initials avatar', () => {
    render(
      <ProfilePreview
        profile={defaultProfile}
        hasStoredCredentials={false}
        linkedinCredentials={{ email: '', password: '' }}
      />
    );
    expect(screen.getByText('JD')).toBeInTheDocument();
  });

  it('renders interests', () => {
    render(
      <ProfilePreview
        profile={defaultProfile}
        hasStoredCredentials={false}
        linkedinCredentials={{ email: '', password: '' }}
      />
    );
    expect(screen.getByText('React')).toBeInTheDocument();
    expect(screen.getByText('Go')).toBeInTheDocument();
  });

  it('shows Connected when hasStoredCredentials is true', () => {
    render(
      <ProfilePreview
        profile={defaultProfile}
        hasStoredCredentials={true}
        linkedinCredentials={{ email: '', password: '' }}
      />
    );
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('shows Not Connected when no credentials', () => {
    render(
      <ProfilePreview
        profile={defaultProfile}
        hasStoredCredentials={false}
        linkedinCredentials={{ email: '', password: '' }}
      />
    );
    expect(screen.getByText('Not Connected')).toBeInTheDocument();
  });

  it('renders the pro tip card', () => {
    render(
      <ProfilePreview
        profile={defaultProfile}
        hasStoredCredentials={false}
        linkedinCredentials={{ email: '', password: '' }}
      />
    );
    expect(screen.getByText('Pro Tip')).toBeInTheDocument();
  });

  it('renders bio', () => {
    render(
      <ProfilePreview
        profile={defaultProfile}
        hasStoredCredentials={false}
        linkedinCredentials={{ email: '', password: '' }}
      />
    );
    expect(screen.getByText('A test bio')).toBeInTheDocument();
  });
});
