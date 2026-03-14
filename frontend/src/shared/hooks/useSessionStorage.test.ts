import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import useSessionStorage from './useSessionStorage';

// Mock the logger to prevent console output during tests
vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('useSessionStorage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it('should return initial value when sessionStorage is empty', () => {
    const { result } = renderHook(() => useSessionStorage('test-key', 'initial'));
    expect(result.current[0]).toBe('initial');
  });

  it('should return stored value from sessionStorage', () => {
    window.sessionStorage.setItem('test-key', JSON.stringify('stored-value'));
    const { result } = renderHook(() => useSessionStorage('test-key', 'initial'));
    expect(result.current[0]).toBe('stored-value');
  });

  it('should update sessionStorage when setValue is called', () => {
    const { result } = renderHook(() => useSessionStorage('test-key', 'initial'));

    act(() => {
      result.current[1]('new-value');
    });

    expect(result.current[0]).toBe('new-value');
    expect(JSON.parse(window.sessionStorage.getItem('test-key') || '')).toBe('new-value');
  });

  it('should support functional updates', () => {
    const { result } = renderHook(() => useSessionStorage('counter', 0));

    act(() => {
      result.current[1]((prev) => prev + 1);
    });

    expect(result.current[0]).toBe(1);

    act(() => {
      result.current[1]((prev) => prev + 5);
    });

    expect(result.current[0]).toBe(6);
  });

  it('should remove value from sessionStorage', () => {
    window.sessionStorage.setItem('test-key', JSON.stringify('stored-value'));
    const { result } = renderHook(() => useSessionStorage('test-key', 'initial'));

    expect(result.current[0]).toBe('stored-value');

    act(() => {
      result.current[2](); // removeValue
    });

    expect(result.current[0]).toBe('initial');
    expect(window.sessionStorage.getItem('test-key')).toBeNull();
  });

  it('should handle malformed JSON in sessionStorage', () => {
    window.sessionStorage.setItem('test-key', 'invalid-json');
    const { result } = renderHook(() => useSessionStorage('test-key', 'initial'));
    expect(result.current[0]).toBe('initial');
  });

  it('should handle sessionStorage write errors gracefully', () => {
    const { result } = renderHook(() => useSessionStorage('test-key', 'initial'));

    const spy = vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded');
    });

    act(() => {
      result.current[1]('new-value');
    });

    // State should remain unchanged when sessionStorage write fails
    expect(result.current[0]).toBe('initial');
    spy.mockRestore();
  });

  it('should return a stable setValue reference across renders', () => {
    const { result } = renderHook(() => useSessionStorage('test-key', 'initial'));

    const firstSetValue = result.current[1];

    act(() => {
      result.current[1]('new-value');
    });

    const secondSetValue = result.current[1];
    expect(firstSetValue).toBe(secondSetValue);
  });

  it('should rehydrate value from sessionStorage when external code writes', () => {
    const { result } = renderHook(() => useSessionStorage('test-key', 'initial'));
    expect(result.current[0]).toBe('initial');

    // Simulate external code writing to sessionStorage
    window.sessionStorage.setItem('test-key', JSON.stringify('external-value'));

    // Hook state is stale until rehydrate is called
    expect(result.current[0]).toBe('initial');

    act(() => {
      result.current[3](); // rehydrate
    });

    expect(result.current[0]).toBe('external-value');
  });

  it('should rehydrate to initial value when sessionStorage key is removed', () => {
    window.sessionStorage.setItem('test-key', JSON.stringify('stored'));
    const { result } = renderHook(() => useSessionStorage('test-key', 'initial'));
    expect(result.current[0]).toBe('stored');

    window.sessionStorage.removeItem('test-key');

    act(() => {
      result.current[3](); // rehydrate
    });

    expect(result.current[0]).toBe('initial');
  });

  it('should not have a StorageEvent listener (sessionStorage is tab-scoped)', () => {
    const addEventSpy = vi.spyOn(window, 'addEventListener');

    renderHook(() => useSessionStorage('test-key', 'initial'));

    const storageCalls = addEventSpy.mock.calls.filter(([event]) => event === 'storage');
    expect(storageCalls).toHaveLength(0);

    addEventSpy.mockRestore();
  });
});
