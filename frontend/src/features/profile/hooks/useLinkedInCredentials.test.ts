import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLinkedInCredentials } from './useLinkedInCredentials';

describe('useLinkedInCredentials', () => {
  it('returns default state', () => {
    const { result } = renderHook(() => useLinkedInCredentials(null));
    expect(result.current.linkedinCredentials).toEqual({ email: '', password: '' });
    expect(result.current.showPassword).toBe(false);
    expect(result.current.hasStoredCredentials).toBe(false);
  });

  it('sets hasStoredCredentials when ciphertext is provided', () => {
    const { result } = renderHook(() =>
      useLinkedInCredentials('sealbox_x25519:b64:encrypted_data')
    );
    expect(result.current.hasStoredCredentials).toBe(true);
  });

  it('does not set hasStoredCredentials when ciphertext is null', () => {
    const { result } = renderHook(() => useLinkedInCredentials(null));
    expect(result.current.hasStoredCredentials).toBe(false);
  });

  it('handles credential field change', () => {
    const { result } = renderHook(() => useLinkedInCredentials(null));
    act(() => {
      result.current.handleLinkedinCredentialsChange('email', 'test@example.com');
    });
    expect(result.current.linkedinCredentials.email).toBe('test@example.com');
  });

  it('toggles password visibility', () => {
    const { result } = renderHook(() => useLinkedInCredentials(null));
    expect(result.current.showPassword).toBe(false);
    act(() => {
      result.current.setShowPassword(true);
    });
    expect(result.current.showPassword).toBe(true);
  });

  it('sets hasStoredCredentials from userProfile linkedin_credentials', () => {
    const userProfile = { linkedin_credentials: 'encrypted_data' };
    const { result } = renderHook(() => useLinkedInCredentials(null, userProfile));
    expect(result.current.hasStoredCredentials).toBe(true);
  });

  it('does not set hasStoredCredentials when userProfile has no linkedin_credentials', () => {
    const userProfile = { first_name: 'Test' };
    const { result } = renderHook(() => useLinkedInCredentials(null, userProfile));
    expect(result.current.hasStoredCredentials).toBe(false);
  });
});
