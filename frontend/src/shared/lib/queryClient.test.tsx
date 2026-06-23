import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider, useQuery, useMutation } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { queryClient } from './queryClient';

const { mockLoggerError } = vi.hoisted(() => ({ mockLoggerError: vi.fn() }));
vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLoggerError,
  }),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

describe('queryClient global error posture', () => {
  beforeEach(() => {
    mockLoggerError.mockClear();
    queryClient.clear();
  });

  it('routes failing queries through the global logger seam', async () => {
    renderHook(
      () =>
        useQuery({
          queryKey: ['failing-query'],
          queryFn: () => Promise.reject(new Error('boom')),
          retry: false,
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(mockLoggerError).toHaveBeenCalled();
    });
    const [message] = mockLoggerError.mock.calls[0];
    expect(message).toMatch(/query/i);
  });

  it('routes failing mutations through the global logger seam', async () => {
    const { result } = renderHook(
      () =>
        useMutation({
          mutationFn: () => Promise.reject(new Error('mutation boom')),
        }),
      { wrapper }
    );

    result.current.mutate();

    await waitFor(() => {
      expect(mockLoggerError).toHaveBeenCalled();
    });
    const [message] = mockLoggerError.mock.calls[0];
    expect(message).toMatch(/mutation/i);
  });

  it('does not retry on 4xx client errors', () => {
    const retry = queryClient.getDefaultOptions().queries?.retry;
    expect(typeof retry).toBe('function');
    if (typeof retry === 'function') {
      const clientError = Object.assign(new Error('bad request'), { status: 400 });
      const serverError = Object.assign(new Error('server error'), { status: 503 });
      expect(retry(0, clientError)).toBe(false);
      expect(retry(0, serverError)).toBe(true);
      expect(retry(2, serverError)).toBe(false);
    }
  });
});
