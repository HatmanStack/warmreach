import { renderHook, act } from '@testing-library/react';
import { useProgressTracker } from '../hooks/useProgressTracker';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('useProgressTracker (integration)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should initialize and update progress', () => {
    const { result } = renderHook(() => useProgressTracker());

    act(() => {
      result.current.initializeProgress(10);
    });

    expect(result.current.progressState.total).toBe(10);
    expect(result.current.progressState.current).toBe(0);
    expect(result.current.getProgressPercentage()).toBe(0);

    act(() => {
      // Advance time to allow for estimation
      vi.advanceTimersByTime(1000);
      result.current.updateProgress(1, 'John Doe');
    });

    expect(result.current.progressState.current).toBe(1);
    expect(result.current.progressState.currentConnectionName).toBe('John Doe');
    expect(result.current.getProgressPercentage()).toBe(10);
  });

  it('should calculate estimated time remaining', () => {
    const { result } = renderHook(() => useProgressTracker());

    act(() => {
      result.current.initializeProgress(10);
    });

    act(() => {
      // Advance 5 seconds for first connection
      vi.advanceTimersByTime(5000);
      result.current.updateProgress(1);
    });

    // 5s per connection, 9 connections left = 45s remaining
    expect(result.current.progressState.estimatedTimeRemaining).toBe(45);
    expect(result.current.getEstimatedTimeString()).toBe('45s remaining');
  });

  it('should handle loading messages', () => {
    const { result } = renderHook(() => useProgressTracker());

    act(() => {
      result.current.setLoadingMessage('Fetching data...', 50);
    });

    expect(result.current.loadingState.isLoading).toBe(true);
    expect(result.current.loadingState.message).toBe('Fetching data...');
    expect(result.current.loadingState.progress).toBe(50);

    act(() => {
      result.current.clearLoading();
    });

    expect(result.current.loadingState.isLoading).toBe(false);
  });

  it('should reset progress', () => {
    const { result } = renderHook(() => useProgressTracker());

    act(() => {
      result.current.initializeProgress(10);
      result.current.updateProgress(5);
      result.current.resetProgress();
    });

    expect(result.current.progressState.total).toBe(0);
    expect(result.current.progressState.current).toBe(0);
  });
});
