import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useProfileForm } from './useProfileForm';

describe('useProfileForm', () => {
  it('returns default profile state', () => {
    const { result } = renderHook(() => useProfileForm(null));
    expect(result.current.profile.name).toBe('Tom, Dick, And Harry');
    expect(result.current.profile.interests).toContain('React');
    expect(result.current.isSaving).toBe(false);
    expect(result.current.newInterest).toBe('');
  });

  it('handles input change', () => {
    const { result } = renderHook(() => useProfileForm(null));
    act(() => {
      result.current.handleInputChange('name', 'Jane Doe');
    });
    expect(result.current.profile.name).toBe('Jane Doe');
  });

  it('adds an interest', () => {
    const { result } = renderHook(() => useProfileForm(null));
    act(() => {
      result.current.setNewInterest('Docker');
    });
    act(() => {
      result.current.addInterest();
    });
    expect(result.current.profile.interests).toContain('Docker');
    expect(result.current.newInterest).toBe('');
  });

  it('does not add duplicate interest', () => {
    const { result } = renderHook(() => useProfileForm(null));
    const initialLength = result.current.profile.interests.length;
    act(() => {
      result.current.setNewInterest('React');
    });
    act(() => {
      result.current.addInterest();
    });
    expect(result.current.profile.interests.length).toBe(initialLength);
  });

  it('does not add empty interest', () => {
    const { result } = renderHook(() => useProfileForm(null));
    const initialLength = result.current.profile.interests.length;
    act(() => {
      result.current.setNewInterest('   ');
    });
    act(() => {
      result.current.addInterest();
    });
    expect(result.current.profile.interests.length).toBe(initialLength);
  });

  it('removes an interest', () => {
    const { result } = renderHook(() => useProfileForm(null));
    act(() => {
      result.current.removeInterest('React');
    });
    expect(result.current.profile.interests).not.toContain('React');
  });

  it('hydrates profile from userProfile context', () => {
    const userProfile = {
      first_name: 'John',
      last_name: 'Smith',
      headline: 'CTO',
      company: 'Acme Corp',
      location: 'New York, NY',
      summary: 'A test bio',
      interests: ['Go', 'Kubernetes'],
      profile_url: 'https://linkedin.com/in/jsmith',
    };
    const { result } = renderHook(() => useProfileForm(userProfile));
    expect(result.current.profile.name).toBe('John Smith');
    expect(result.current.profile.title).toBe('CTO');
    expect(result.current.profile.company).toBe('Acme Corp');
    expect(result.current.profile.interests).toEqual(['Go', 'Kubernetes']);
  });
});
