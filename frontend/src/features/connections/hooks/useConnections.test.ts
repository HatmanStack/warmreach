import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useConnections } from './useConnections';
import { createWrapper } from '@/test-utils/queryWrapper';
import type { Connection } from '@/shared/types';

const mockGetConnectionsByStatus = vi.fn();

// Mock the dependencies
vi.mock('@/shared/services', () => ({
  lambdaApiService: {
    getConnectionsByStatus: (...args: unknown[]) => mockGetConnectionsByStatus(...args),
    updateConnectionStatus: vi.fn(),
  },
  websocketService: { onMessage: vi.fn(() => vi.fn()), onStateChange: vi.fn(() => vi.fn()) },
  commandService: {},
}));

vi.mock('@/features/auth', () => ({
  useAuth: vi.fn(() => ({ user: { id: 'test-user' } })),
}));

import { useAuth } from '@/features/auth';

const mockUseAuth = useAuth as ReturnType<typeof vi.fn>;

// Test fixtures
const validConnection: Connection = {
  id: 'conn-1',
  first_name: 'John',
  last_name: 'Doe',
  position: 'Software Engineer',
  company: 'Test Corp',
  status: 'ally',
  conversion_likelihood: 'high',
};

const validConnection2: Connection = {
  id: 'conn-2',
  first_name: 'Jane',
  last_name: 'Smith',
  position: 'Product Manager',
  company: 'Another Corp',
  status: 'possible',
  conversion_likelihood: 'medium',
};

describe('useConnections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: { id: 'test-user' } });
  });

  describe('fetching connections', () => {
    it('should return typed Connection[] when API returns valid data', async () => {
      mockGetConnectionsByStatus.mockResolvedValue([validConnection, validConnection2]);

      const { result } = renderHook(() => useConnections(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.connections).toHaveLength(2);
      expect(result.current.connections[0].first_name).toBe('John');
      expect(result.current.connections[0].conversion_likelihood).toBe('high');
      expect(result.current.connections[1].conversion_likelihood).toBe('medium');
      expect(result.current.error).toBeNull();
    });

    it('should handle empty response', async () => {
      mockGetConnectionsByStatus.mockResolvedValue([]);

      const { result } = renderHook(() => useConnections(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.connections).toEqual([]);
      expect(result.current.error).toBeNull();
    });

    it('should set error state on API failure', async () => {
      mockGetConnectionsByStatus.mockRejectedValue(new Error('Failed to fetch connections'));

      const { result } = renderHook(() => useConnections(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.connections).toEqual([]);
      expect(result.current.error).toBe('Failed to fetch connections');
    });

    it('should handle network errors', async () => {
      mockGetConnectionsByStatus.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useConnections(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.connections).toEqual([]);
      expect(result.current.error).toBe('Network error');
    });

    it('should pass status filter to API call', async () => {
      mockGetConnectionsByStatus.mockResolvedValue([validConnection]);

      const filters = { status: 'ally', limit: 10 };
      renderHook(() => useConnections(filters), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(mockGetConnectionsByStatus).toHaveBeenCalledWith('ally');
      });
    });
  });

  describe('conversion_likelihood enum handling', () => {
    it('should correctly handle high conversion likelihood', async () => {
      const conn = { ...validConnection, conversion_likelihood: 'high' as const };
      mockGetConnectionsByStatus.mockResolvedValue([conn]);

      const { result } = renderHook(() => useConnections(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.connections[0].conversion_likelihood).toBe('high');
    });

    it('should correctly handle medium conversion likelihood', async () => {
      const conn = { ...validConnection, conversion_likelihood: 'medium' as const };
      mockGetConnectionsByStatus.mockResolvedValue([conn]);

      const { result } = renderHook(() => useConnections(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.connections[0].conversion_likelihood).toBe('medium');
    });

    it('should correctly handle low conversion likelihood', async () => {
      const conn = { ...validConnection, conversion_likelihood: 'low' as const };
      mockGetConnectionsByStatus.mockResolvedValue([conn]);

      const { result } = renderHook(() => useConnections(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.connections[0].conversion_likelihood).toBe('low');
    });

    it('should handle connections without conversion_likelihood', async () => {
      const conn = { ...validConnection };
      delete (conn as Partial<Connection>).conversion_likelihood;
      mockGetConnectionsByStatus.mockResolvedValue([conn]);

      const { result } = renderHook(() => useConnections(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.connections[0].conversion_likelihood).toBeUndefined();
    });
  });
});
