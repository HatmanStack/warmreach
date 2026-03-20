import { renderHook, act } from '@testing-library/react';
import { useProfileInit } from '../useProfileInit';
import { useCommand, useToast } from '@/shared/hooks';
import { createWrapper, buildMockToastReturn, buildMockCommandReturn } from '@/test-utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/hooks', () => ({
  useCommand: vi.fn(),
  useToast: vi.fn(),
}));

describe('useProfileInit', () => {
  const mockExecute = vi.fn();
  const mockReset = vi.fn();
  const mockToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useToast).mockReturnValue(buildMockToastReturn(mockToast));
    vi.mocked(useCommand).mockReturnValue(
      buildMockCommandReturn({
        execute: mockExecute,
        reset: mockReset,
      })
    );
  });

  const Wrapper = createWrapper();

  it('should call execute on initializeProfile', async () => {
    const { result } = renderHook(() => useProfileInit(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.initializeProfile();
    });

    expect(mockExecute).toHaveBeenCalled();
    expect(mockReset).toHaveBeenCalled();
  });

  it('should handle successful completion', async () => {
    const onSuccess = vi.fn();
    const { result, rerender } = renderHook(() => useProfileInit(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.initializeProfile(onSuccess);
    });

    // Simulate completion
    vi.mocked(useCommand).mockReturnValue(
      buildMockCommandReturn({
        execute: mockExecute,
        reset: mockReset,
        status: 'completed',
        result: { success: true },
      })
    );

    rerender();

    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Success' }));
    expect(onSuccess).toHaveBeenCalled();
  });

  it('should handle healing status', async () => {
    const { result, rerender } = renderHook(() => useProfileInit(), { wrapper: Wrapper });

    vi.mocked(useCommand).mockReturnValue(
      buildMockCommandReturn({
        execute: mockExecute,
        reset: mockReset,
        status: 'completed',
        result: { healing: true, message: 'Healing...' },
      })
    );

    rerender();

    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Processing' }));
    expect(result.current.initializationMessage).toBe('Healing...');
  });

  it('should handle failure', async () => {
    const { result, rerender } = renderHook(() => useProfileInit(), { wrapper: Wrapper });

    vi.mocked(useCommand).mockReturnValue(
      buildMockCommandReturn({
        execute: mockExecute,
        reset: mockReset,
        status: 'failed',
        error: 'Dispatch failed',
      })
    );

    rerender();

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Error',
        variant: 'destructive',
      })
    );
    expect(result.current.initializationError).toBe('Dispatch failed');
  });

  it('should clear messages', () => {
    const { result } = renderHook(() => useProfileInit(), { wrapper: Wrapper });

    act(() => {
      result.current.clearMessages();
    });

    expect(result.current.initializationMessage).toBe('');
    expect(result.current.initializationError).toBe('');
  });
});
