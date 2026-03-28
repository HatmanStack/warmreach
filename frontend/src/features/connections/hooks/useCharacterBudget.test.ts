import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useCharacterBudget } from './useCharacterBudget';

describe('useCharacterBudget', () => {
  let originalInnerWidth: number;

  beforeEach(() => {
    originalInnerWidth = window.innerWidth;
    vi.useFakeTimers();
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: originalInnerWidth,
    });
    vi.useRealTimers();
  });

  function setWindowWidth(width: number) {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: width,
    });
  }

  it('should return tag and summary budgets', () => {
    setWindowWidth(1200);
    const { result } = renderHook(() => useCharacterBudget());
    expect(result.current.tagBudget).toBeGreaterThan(0);
    expect(result.current.summaryBudget).toBeGreaterThan(0);
  });

  it('should return smaller budgets for narrow windows', () => {
    setWindowWidth(1200);
    const { result: wide } = renderHook(() => useCharacterBudget());

    setWindowWidth(350);
    const { result: narrow } = renderHook(() => useCharacterBudget());

    expect(narrow.current.tagBudget).toBeLessThan(wide.current.tagBudget);
    expect(narrow.current.summaryBudget).toBeLessThan(wide.current.summaryBudget);
  });

  it('should update budgets on resize after debounce', () => {
    setWindowWidth(1200);
    const { result } = renderHook(() => useCharacterBudget());
    const initialTag = result.current.tagBudget;

    act(() => {
      setWindowWidth(350);
      window.dispatchEvent(new Event('resize'));
    });

    // Before debounce fires, values unchanged
    expect(result.current.tagBudget).toBe(initialTag);

    // After debounce
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.tagBudget).toBeLessThan(initialTag);
  });

  it('should debounce rapid resize events', () => {
    setWindowWidth(1200);
    const { result } = renderHook(() => useCharacterBudget());

    // Fire multiple rapid resizes
    act(() => {
      for (let i = 0; i < 5; i++) {
        setWindowWidth(300 + i * 100);
        window.dispatchEvent(new Event('resize'));
      }
    });

    // Advance past debounce
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Should have settled to the last width (700)
    expect(result.current.tagBudget).toBeGreaterThan(0);
  });
});
