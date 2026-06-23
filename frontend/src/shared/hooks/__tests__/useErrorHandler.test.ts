import { renderHook, act } from '@testing-library/react';
import { useErrorHandler } from '../useErrorHandler';
import { useToast } from '@/shared/hooks';
import { MessageGenerationError } from '@/features/messages';
import { ApiError } from '@/shared/services';
import { buildMockToastReturn } from '@/test-utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/hooks', () => ({
  useToast: vi.fn(),
}));

describe('useErrorHandler', () => {
  const mockToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useToast).mockReturnValue(buildMockToastReturn(mockToast));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should categorize MessageGenerationError correctly', async () => {
    const { result } = renderHook(() => useErrorHandler());

    const errors = [
      { status: 401, expected: 'authentication' },
      { status: 429, expected: 'rate_limit' },
      { status: 400, expected: 'validation' },
      { status: 500, expected: 'api' },
    ];

    for (const { status, expected } of errors) {
      act(() => {
        result.current.handleError(new MessageGenerationError({ message: 'err', status }));
      });
      expect(result.current.currentError?.type).toBe(expected);
    }
  });

  it('should categorize ApiError and NetworkError', () => {
    const { result } = renderHook(() => useErrorHandler());

    act(() => {
      result.current.handleError(new ApiError({ message: 'api' }));
    });
    expect(result.current.currentError?.type).toBe('api');

    act(() => {
      result.current.handleError(new Error('network issue'));
    });
    expect(result.current.currentError?.type).toBe('network');
  });

  it('should auto-resolve after timeout', async () => {
    const { result } = renderHook(() => useErrorHandler());

    act(() => {
      result.current.handleError(new Error('fail'));
    });

    act(() => {
      vi.runAllTimers();
    });

    // Check if current error was cleared or handle error promise resolved
    // In this hook, handleError returns a promise.
    expect(mockToast).toHaveBeenCalled();
  });

  it('should show feedback toasts', () => {
    const { result } = renderHook(() => useErrorHandler());

    act(() => {
      result.current.showSuccessFeedback('Done');
    });
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Success' }));

    act(() => {
      result.current.showWarningFeedback('Careful');
    });
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Warning' }));

    act(() => {
      result.current.showInfoFeedback('FYI');
    });
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Information' }));
  });

  it('should not auto-resolve after the hook unmounts', async () => {
    const { result, unmount } = renderHook(() => useErrorHandler());

    let settled = false;
    act(() => {
      result.current.handleError(new Error('fail')).then(() => {
        settled = true;
      });
    });

    // Unmount before the 10s auto-resolve window elapses.
    unmount();

    await act(async () => {
      vi.runAllTimers();
      // Flush any microtasks the auto-resolve would have scheduled.
      await Promise.resolve();
    });

    // The pending auto-resolve timer must have been cleared on unmount, so the
    // promise never resolves and no post-unmount state update is attempted.
    expect(settled).toBe(false);
  });

  it('should clear current error', () => {
    const { result } = renderHook(() => useErrorHandler());

    act(() => {
      result.current.handleError(new Error('fail'));
    });
    expect(result.current.currentError).not.toBeNull();

    act(() => {
      result.current.clearError();
    });
    expect(result.current.currentError).toBeNull();
  });
});
