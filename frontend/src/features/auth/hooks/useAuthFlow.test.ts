import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAuthFlow } from './useAuthFlow';

const createMockDeps = () => ({
  signIn: vi.fn().mockResolvedValue({ error: null }),
  signUp: vi.fn().mockResolvedValue({ error: null }),
  confirmSignUp: vi.fn().mockResolvedValue({ error: null }),
  resendConfirmationCode: vi.fn().mockResolvedValue({ error: null }),
  toast: vi.fn(),
  navigate: vi.fn(),
});

const createFormEvent = () => ({ preventDefault: vi.fn() }) as unknown as React.FormEvent;

describe('useAuthFlow', () => {
  it('returns initial state', () => {
    const deps = createMockDeps();
    const { result } = renderHook(() => useAuthFlow(deps));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.showPassword).toBe(false);
    expect(result.current.showVerification).toBe(false);
    expect(result.current.signInData).toEqual({ email: '', password: '' });
    expect(result.current.signUpData).toEqual({
      email: '',
      password: '',
      firstName: '',
      lastName: '',
    });
  });

  it('handles successful sign in', async () => {
    const deps = createMockDeps();
    const { result } = renderHook(() => useAuthFlow(deps));

    act(() => {
      result.current.setSignInData({ email: 'test@example.com', password: 'pass123' });
    });

    await act(async () => {
      await result.current.handleSignIn(createFormEvent());
    });

    expect(deps.signIn).toHaveBeenCalledWith('test@example.com', 'pass123');
    expect(deps.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Welcome back!' }));
    expect(deps.navigate).toHaveBeenCalledWith('/dashboard');
    expect(result.current.isLoading).toBe(false);
  });

  it('handles sign in failure', async () => {
    const deps = createMockDeps();
    deps.signIn.mockResolvedValue({ error: { message: 'Bad creds' } });
    const { result } = renderHook(() => useAuthFlow(deps));

    await act(async () => {
      await result.current.handleSignIn(createFormEvent());
    });

    expect(deps.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Sign In Failed', variant: 'destructive' })
    );
    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it('handles successful sign up (mock auth)', async () => {
    const deps = createMockDeps();
    const { result } = renderHook(() => useAuthFlow(deps));

    act(() => {
      result.current.setSignUpData({
        email: 'new@example.com',
        password: 'pass123',
        firstName: 'John',
        lastName: 'Doe',
      });
    });

    await act(async () => {
      await result.current.handleSignUp(createFormEvent());
    });

    expect(deps.signUp).toHaveBeenCalledWith('new@example.com', 'pass123', 'John', 'Doe');
    expect(deps.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Welcome!' }));
    expect(deps.navigate).toHaveBeenCalledWith('/dashboard');
  });

  it('handles sign up failure', async () => {
    const deps = createMockDeps();
    deps.signUp.mockResolvedValue({ error: { message: 'Email taken' } });
    const { result } = renderHook(() => useAuthFlow(deps));

    await act(async () => {
      await result.current.handleSignUp(createFormEvent());
    });

    expect(deps.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Sign Up Failed', variant: 'destructive' })
    );
  });

  it('handles verification success', async () => {
    const deps = createMockDeps();
    const { result } = renderHook(() => useAuthFlow(deps));

    await act(async () => {
      await result.current.handleVerification(createFormEvent());
    });

    expect(deps.confirmSignUp).toHaveBeenCalled();
    expect(deps.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Email Verified!' }));
  });

  it('handles resend code', async () => {
    const deps = createMockDeps();
    const { result } = renderHook(() => useAuthFlow(deps));

    await act(async () => {
      await result.current.handleResendCode();
    });

    expect(deps.resendConfirmationCode).toHaveBeenCalled();
    expect(deps.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Code Sent' }));
  });

  it('toggles password visibility', () => {
    const deps = createMockDeps();
    const { result } = renderHook(() => useAuthFlow(deps));
    expect(result.current.showPassword).toBe(false);
    act(() => {
      result.current.setShowPassword(true);
    });
    expect(result.current.showPassword).toBe(true);
  });
});
