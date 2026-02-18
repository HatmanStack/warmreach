import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mocks
const { mockDispatch, mockOnCommandMessage } = vi.hoisted(() => ({
  mockDispatch: vi.fn(),
  mockOnCommandMessage: vi.fn(),
}));

vi.mock('@/shared/services/commandService', () => ({
  commandService: {
    dispatch: mockDispatch,
    onCommandMessage: mockOnCommandMessage,
  },
}));

vi.mock('@/shared/services/websocketService', () => ({
  websocketService: { onMessage: vi.fn(() => vi.fn()) },
}));

import { useCommand } from './useCommand';

describe('useCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with idle status', () => {
    const { result } = renderHook(() => useCommand('linkedin:search'));
    expect(result.current.status).toBe('idle');
    expect(result.current.progress).toBeNull();
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('transitions to dispatching then executing on successful dispatch', async () => {
    const unsubscribe = vi.fn();
    mockDispatch.mockResolvedValueOnce({ commandId: 'cmd-1' });
    mockOnCommandMessage.mockReturnValueOnce(unsubscribe);

    const { result } = renderHook(() => useCommand('linkedin:search'));

    await act(async () => {
      await result.current.execute({ query: 'test' });
    });

    expect(mockDispatch).toHaveBeenCalledWith('linkedin:search', { query: 'test' });
    expect(result.current.status).toBe('executing');
    expect(mockOnCommandMessage).toHaveBeenCalledWith('cmd-1', expect.any(Function));
  });

  it('handles dispatch failure', async () => {
    mockDispatch.mockRejectedValueOnce(new Error('No agent connected'));

    const { result } = renderHook(() => useCommand('linkedin:search'));

    await act(async () => {
      await result.current.execute({ query: 'test' });
    });

    expect(result.current.status).toBe('failed');
    expect(result.current.error).toBe('No agent connected');
  });

  it('handles progress messages', async () => {
    let messageCallback: (...args: unknown[]) => void;
    mockDispatch.mockResolvedValueOnce({ commandId: 'cmd-2' });
    mockOnCommandMessage.mockImplementationOnce((_id: string, cb: (...args: unknown[]) => void) => {
      messageCallback = cb;
      return vi.fn();
    });

    const { result } = renderHook(() => useCommand('linkedin:search'));

    await act(async () => {
      await result.current.execute({});
    });

    act(() => {
      messageCallback!({ action: 'progress', step: 1, total: 5, message: 'Searching...' });
    });

    expect(result.current.progress).toEqual({
      step: 1,
      total: 5,
      message: 'Searching...',
    });
  });

  it('handles result messages and transitions to completed', async () => {
    let messageCallback: (...args: unknown[]) => void;
    const unsubscribe = vi.fn();
    mockDispatch.mockResolvedValueOnce({ commandId: 'cmd-3' });
    mockOnCommandMessage.mockImplementationOnce((_id: string, cb: (...args: unknown[]) => void) => {
      messageCallback = cb;
      return unsubscribe;
    });

    const { result } = renderHook(() => useCommand<{ items: string[] }>('linkedin:search'));

    await act(async () => {
      await result.current.execute({});
    });

    act(() => {
      messageCallback!({ action: 'result', data: { items: ['a', 'b'] } });
    });

    expect(result.current.status).toBe('completed');
    expect(result.current.result).toEqual({ items: ['a', 'b'] });
  });

  it('handles error messages and transitions to failed', async () => {
    let messageCallback: (...args: unknown[]) => void;
    mockDispatch.mockResolvedValueOnce({ commandId: 'cmd-4' });
    mockOnCommandMessage.mockImplementationOnce((_id: string, cb: (...args: unknown[]) => void) => {
      messageCallback = cb;
      return vi.fn();
    });

    const { result } = renderHook(() => useCommand('linkedin:search'));

    await act(async () => {
      await result.current.execute({});
    });

    act(() => {
      messageCallback!({ action: 'error', message: 'Rate limited' });
    });

    expect(result.current.status).toBe('failed');
    expect(result.current.error).toBe('Rate limited');
  });

  it('reset returns to idle state', async () => {
    mockDispatch.mockRejectedValueOnce(new Error('fail'));

    const { result } = renderHook(() => useCommand('linkedin:search'));

    await act(async () => {
      await result.current.execute({});
    });

    expect(result.current.status).toBe('failed');

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
    expect(result.current.result).toBeNull();
    expect(result.current.progress).toBeNull();
  });

  it('cleans up listener on unmount', async () => {
    const unsubscribe = vi.fn();
    mockDispatch.mockResolvedValueOnce({ commandId: 'cmd-5' });
    mockOnCommandMessage.mockReturnValueOnce(unsubscribe);

    const { result, unmount } = renderHook(() => useCommand('linkedin:search'));

    await act(async () => {
      await result.current.execute({});
    });

    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('cleans up previous listener when executing new command', async () => {
    const unsubscribe1 = vi.fn();
    const unsubscribe2 = vi.fn();
    mockDispatch.mockResolvedValueOnce({ commandId: 'cmd-6' });
    mockOnCommandMessage.mockReturnValueOnce(unsubscribe1);

    const { result } = renderHook(() => useCommand('linkedin:search'));

    await act(async () => {
      await result.current.execute({ query: 'first' });
    });

    mockDispatch.mockResolvedValueOnce({ commandId: 'cmd-7' });
    mockOnCommandMessage.mockReturnValueOnce(unsubscribe2);

    await act(async () => {
      await result.current.execute({ query: 'second' });
    });

    expect(unsubscribe1).toHaveBeenCalled();
  });
});
