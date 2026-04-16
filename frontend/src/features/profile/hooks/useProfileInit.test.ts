import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createWrapper } from '@/test-utils/queryWrapper';

const mockExecute = vi.fn();
const mockReset = vi.fn();
const mockToast = vi.fn();
let mockStatus = 'idle';
let mockResult: unknown = null;
let mockError: string | null = null;

vi.mock('@/shared/hooks', () => ({
  useCommand: () => ({
    execute: mockExecute,
    status: mockStatus,
    result: mockResult,
    error: mockError,
    reset: mockReset,
  }),
  useToast: () => ({ toast: mockToast }),
  useErrorHandler: vi.fn(),
}));

import { useProfileInit } from './useProfileInit';

describe('useProfileInit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatus = 'idle';
    mockResult = null;
    mockError = null;
  });

  it('should initialize with default state', () => {
    const { result } = renderHook(() => useProfileInit(), { wrapper: createWrapper() });

    expect(result.current.isInitializing).toBe(false);
    expect(result.current.initializationMessage).toBe('');
    expect(result.current.initializationError).toBe('');
  });

  describe('initializeProfile', () => {
    it('should call execute on initializeProfile', async () => {
      const { result } = renderHook(() => useProfileInit(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.initializeProfile();
      });

      expect(mockReset).toHaveBeenCalled();
      expect(mockExecute).toHaveBeenCalledWith({});
    });

    it('should show loading when dispatching', () => {
      mockStatus = 'dispatching';
      const { result } = renderHook(() => useProfileInit(), { wrapper: createWrapper() });

      expect(result.current.isInitializing).toBe(true);
    });

    it('should show loading when executing', () => {
      mockStatus = 'executing';
      const { result } = renderHook(() => useProfileInit(), { wrapper: createWrapper() });

      expect(result.current.isInitializing).toBe(true);
    });

    it('should not be loading when idle', () => {
      mockStatus = 'idle';
      const { result } = renderHook(() => useProfileInit(), { wrapper: createWrapper() });

      expect(result.current.isInitializing).toBe(false);
    });

    it('should report error from command', () => {
      mockStatus = 'failed';
      mockError = 'Service unavailable';
      const { result } = renderHook(() => useProfileInit(), { wrapper: createWrapper() });

      expect(result.current.isInitializing).toBe(false);
    });
  });

  describe('status transitions', () => {
    it('should handle successful completion', () => {
      mockStatus = 'completed';
      mockResult = { success: true, message: 'Done' };

      const { result } = renderHook(() => useProfileInit(), { wrapper: createWrapper() });

      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Success' }));
      expect(result.current.initializationMessage).toBe('Done');
    });

    it('should invoke onSuccess callback on successful completion', async () => {
      const { result, rerender } = renderHook(() => useProfileInit(), {
        wrapper: createWrapper(),
      });

      const onSuccess = vi.fn();
      await act(async () => {
        await result.current.initializeProfile(onSuccess);
      });

      // Simulate completion
      mockStatus = 'completed';
      mockResult = { success: true };
      rerender();

      expect(onSuccess).toHaveBeenCalled();
    });

    it('should handle healing status', () => {
      mockStatus = 'completed';
      mockResult = { healing: true, message: 'Healing...' };

      const { result } = renderHook(() => useProfileInit(), { wrapper: createWrapper() });

      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Processing' }));
      expect(result.current.initializationMessage).toBe('Healing...');
    });

    it('should handle failure', () => {
      mockStatus = 'failed';
      mockError = 'Dispatch failed';

      const { result } = renderHook(() => useProfileInit(), { wrapper: createWrapper() });

      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Error',
          variant: 'destructive',
        })
      );
      expect(result.current.initializationError).toBe('Dispatch failed');
    });
  });

  describe('clearMessages', () => {
    it('should reset message and error', () => {
      const { result } = renderHook(() => useProfileInit(), { wrapper: createWrapper() });

      act(() => {
        result.current.clearMessages();
      });

      expect(result.current.initializationMessage).toBe('');
      expect(result.current.initializationError).toBe('');
    });
  });
});
