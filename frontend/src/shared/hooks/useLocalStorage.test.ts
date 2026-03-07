import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import useLocalStorage from './useLocalStorage';

// Mock the logger to prevent console output during tests
vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('useLocalStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('should return initial value when localStorage is empty', () => {
    const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));
    expect(result.current[0]).toBe('initial');
  });

  it('should return stored value from localStorage', () => {
    window.localStorage.setItem('test-key', JSON.stringify('stored-value'));
    const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));
    expect(result.current[0]).toBe('stored-value');
  });

  it('should update localStorage when setValue is called', () => {
    const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));

    act(() => {
      result.current[1]('new-value');
    });

    expect(result.current[0]).toBe('new-value');
    expect(JSON.parse(window.localStorage.getItem('test-key') || '')).toBe('new-value');
  });

  it('should support functional updates', () => {
    const { result } = renderHook(() => useLocalStorage('counter', 0));

    act(() => {
      result.current[1]((prev) => prev + 1);
    });

    expect(result.current[0]).toBe(1);

    act(() => {
      result.current[1]((prev) => prev + 5);
    });

    expect(result.current[0]).toBe(6);
  });

  it('should remove value from localStorage', () => {
    window.localStorage.setItem('test-key', JSON.stringify('stored-value'));
    const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));

    expect(result.current[0]).toBe('stored-value');

    act(() => {
      result.current[2](); // removeValue
    });

    expect(result.current[0]).toBe('initial');
    expect(window.localStorage.getItem('test-key')).toBeNull();
  });

  it('should handle malformed JSON in localStorage', () => {
    window.localStorage.setItem('test-key', 'invalid-json');
    const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));
    expect(result.current[0]).toBe('initial');
  });

  it('should handle localStorage write errors', () => {
    const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded');
    });

    const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));

    act(() => {
      result.current[1]('new-value');
    });

    // State should still update even if localStorage fails
    expect(result.current[0]).toBe('new-value');
    spy.mockRestore();
  });

  it('should handle storage events from other tabs', () => {
    const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));

    act(() => {
      const event = new StorageEvent('storage', {
        key: 'test-key',
        newValue: JSON.stringify('other-tab-value'),
      });
      window.dispatchEvent(event);
    });

    expect(result.current[0]).toBe('other-tab-value');
  });

  it('should ignore storage events for other keys', () => {
    const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));

    act(() => {
      const event = new StorageEvent('storage', {
        key: 'different-key',
        newValue: JSON.stringify('ignored'),
      });
      window.dispatchEvent(event);
    });

    expect(result.current[0]).toBe('initial');
  });
});
