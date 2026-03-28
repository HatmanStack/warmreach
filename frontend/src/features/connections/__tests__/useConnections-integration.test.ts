import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server, createAuthenticatedWrapper, buildConnection } from '@/test-utils';
import { useConnections } from '../hooks/useConnections';
import { describe, it, expect } from 'vitest';

describe('useConnections (integration)', () => {
  it('should fetch connections from API', async () => {
    const mockConnections = [
      buildConnection({ id: 'conn-1', first_name: 'John', last_name: 'Doe' }),
      buildConnection({ id: 'conn-2', first_name: 'Jane', last_name: 'Smith' }),
    ];

    server.use(
      http.post('*/edges', async ({ request }) => {
        const body = (await request.json()) as any;
        if (body.operation === 'get_connections_by_status') {
          return HttpResponse.json({ connections: mockConnections });
        }
        return new HttpResponse(null, { status: 404 });
      })
    );

    const { result } = renderHook(() => useConnections(), {
      wrapper: createAuthenticatedWrapper(),
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.connections).toHaveLength(2);
    expect(result.current.connections[0].first_name).toBe('John');
  });

  it('should handle API errors during fetch', async () => {
    server.use(
      http.post('*/edges', () => {
        return new HttpResponse(JSON.stringify({ error: 'Database error' }), { status: 500 });
      })
    );

    const { result } = renderHook(() => useConnections(), {
      wrapper: createAuthenticatedWrapper(),
    });

    await waitFor(
      () => {
        expect(result.current.loading).toBe(false);
      },
      { timeout: 10000 }
    );

    expect(result.current.error).toBeDefined();
    expect(result.current.connections).toHaveLength(0);
  });

  it('should update connection status via API', async () => {
    const connection = buildConnection({ id: 'conn-1', status: 'possible' });

    server.use(
      http.post('*/edges', async ({ request }) => {
        const body = (await request.json()) as any;
        if (body.operation === 'upsert_status') {
          return HttpResponse.json({ success: true });
        }
        if (body.operation === 'get_connections_by_status') {
          return HttpResponse.json({ connections: [connection] });
        }
        return new HttpResponse(null, { status: 404 });
      })
    );

    const { result } = renderHook(() => useConnections(), {
      wrapper: createAuthenticatedWrapper(),
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const success = await result.current.updateConnection('conn-1', { status: 'ally' });
    expect(success).toBe(true);

    // React Query should have updated the cache
    await waitFor(() => {
      expect(result.current.connections[0].status).toBe('ally');
    });
  });
});
