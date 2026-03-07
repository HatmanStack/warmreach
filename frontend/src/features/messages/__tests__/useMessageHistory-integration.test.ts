import { renderHook, waitFor, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server, createAuthenticatedWrapper, buildMessage } from '@/test-utils';
import { useMessageHistory } from '../hooks/useMessageHistory';
import { describe, it, expect } from 'vitest';

describe('useMessageHistory (integration)', () => {
  it('should fetch message history for a connection', async () => {
    const mockMessages = [
      buildMessage({ id: 'msg-1', content: 'Hello' }),
      buildMessage({ id: 'msg-2', content: 'How are you?' }),
    ];

    server.use(
      http.post('*/edges', async ({ request }) => {
        const body = (await request.json()) as any;
        if (body.operation === 'get_messages') {
          return HttpResponse.json({ messages: mockMessages });
        }
        return new HttpResponse(null, { status: 404 });
      })
    );

    const { result } = renderHook(() => useMessageHistory(), {
      wrapper: createAuthenticatedWrapper(),
    });

    await act(async () => {
      await result.current.fetchHistory('conn-1');
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].content).toBe('Hello');
  });

  it('should handle API errors gracefully', async () => {
    server.use(
      http.post('*/edges', () => {
        return new HttpResponse(JSON.stringify({ error: 'Server error' }), { status: 500 });
      })
    );

    const { result } = renderHook(() => useMessageHistory(), {
      wrapper: createAuthenticatedWrapper(),
    });

    await act(async () => {
      await result.current.fetchHistory('conn-1');
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBeDefined();
    expect(result.current.messages).toHaveLength(0);
  });

  it('should clear history', async () => {
    const { result } = renderHook(() => useMessageHistory(), {
      wrapper: createAuthenticatedWrapper(),
    });

    act(() => {
      result.current.addMessage(buildMessage({ content: 'Test' }));
    });

    expect(result.current.messages).toHaveLength(1);

    act(() => {
      result.current.clearHistory();
    });

    expect(result.current.messages).toHaveLength(0);
  });
});
