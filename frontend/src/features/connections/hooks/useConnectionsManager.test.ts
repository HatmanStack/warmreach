import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { createWrapper } from '@/test-utils/queryWrapper';
import type { Connection } from '@/types';

// Mock dependencies BEFORE importing hook
vi.mock('@/features/auth', () => ({
  useAuth: vi.fn(() => ({ user: { id: 'user-123' } })),
}));

vi.mock('@/shared/hooks', () => ({
  useToast: vi.fn(() => ({ toast: vi.fn() })),
}));

vi.mock('@/features/tier', () => ({
  useTier: vi.fn(() => ({ isFeatureEnabled: () => false, tier: 'free' })),
}));

vi.mock('@/shared/services', () => ({
  lambdaApiService: {
    getConnectionsByStatus: vi.fn(() => Promise.resolve([])),
    computeRelationshipScores: vi.fn(() => Promise.resolve({ scoresComputed: 0 })),
  },
  ApiError: class ApiError extends Error {},
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
}));

// Import hook AFTER mocks are set up
import { useConnectionsManager } from './useConnectionsManager';
import { useAuth } from '@/features/auth';
import { useTier } from '@/features/tier';
import { lambdaApiService } from '@/shared/services';

const mockUseAuth = useAuth as ReturnType<typeof vi.fn>;
const mockGetConnectionsByStatus = lambdaApiService.getConnectionsByStatus as ReturnType<
  typeof vi.fn
>;

const mockConnections: Connection[] = [
  {
    id: '1',
    first_name: 'John',
    last_name: 'Doe',
    status: 'ally',
    tags: ['tech'],
    position: 'Engineer',
    company: 'Test Corp',
  } as Connection,
  {
    id: '2',
    first_name: 'Jane',
    last_name: 'Smith',
    status: 'incoming',
    tags: ['design'],
    position: 'Designer',
    company: 'Design Co',
  } as Connection,
  {
    id: '3',
    first_name: 'Bob',
    last_name: 'Wilson',
    status: 'outgoing',
    tags: ['tech'],
    position: 'Manager',
    company: 'Big Corp',
  } as Connection,
  {
    id: '4',
    first_name: 'Alice',
    last_name: 'Lee',
    status: 'possible',
    tags: [],
    position: 'PM',
    company: 'Startup Inc',
  } as Connection,
];

describe('useConnectionsManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: { id: 'user-123' } });
    mockGetConnectionsByStatus.mockResolvedValue(mockConnections);
  });

  describe('initialization', () => {
    it('returns initial state before fetch', () => {
      mockGetConnectionsByStatus.mockResolvedValue([]);

      const { result } = renderHook(() => useConnectionsManager(), {
        wrapper: createWrapper(),
      });

      expect(result.current.selectedStatus).toBe('all');
      expect(result.current.activeTags).toEqual([]);
      expect(result.current.selectedConnections).toEqual([]);
    });

    it('fetches connections on mount when user exists', async () => {
      const { result } = renderHook(() => useConnectionsManager(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.connectionsLoading).toBe(false);
      });

      expect(mockGetConnectionsByStatus).toHaveBeenCalled();
      expect(result.current.connections).toEqual(mockConnections);
    });

    it('does not fetch when user is null', () => {
      mockUseAuth.mockReturnValue({ user: null });

      renderHook(() => useConnectionsManager(), {
        wrapper: createWrapper(),
      });

      expect(mockGetConnectionsByStatus).not.toHaveBeenCalled();
    });
  });

  describe('connectionCounts', () => {
    it('calculates counts by status', async () => {
      const { result } = renderHook(() => useConnectionsManager(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.connectionsLoading).toBe(false);
      });

      expect(result.current.connectionCounts).toEqual({
        incoming: 1,
        outgoing: 1,
        ally: 1,
        total: 3,
      });
    });
  });

  describe('filteredConnections', () => {
    it('filters status=all to show incoming+outgoing+ally', async () => {
      const { result } = renderHook(() => useConnectionsManager(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.connections.length).toBeGreaterThan(0);
      });

      // 'possible' should be excluded from 'all'
      expect(result.current.filteredConnections.length).toBe(3);
      expect(
        result.current.filteredConnections.every((c: Connection) =>
          ['incoming', 'outgoing', 'ally'].includes(c.status)
        )
      ).toBe(true);
    });

    it('filters by specific status', async () => {
      const { result } = renderHook(() => useConnectionsManager(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.connections.length).toBe(4);
      });

      act(() => {
        result.current.setSelectedStatus('ally');
      });

      expect(result.current.filteredConnections.length).toBe(1);
      expect(result.current.filteredConnections[0].id).toBe('1');
    });
  });

  describe('newConnections', () => {
    it('returns only possible status connections', async () => {
      const { result } = renderHook(() => useConnectionsManager(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.connections.length).toBe(4);
      });

      expect(result.current.newConnections.length).toBe(1);
      expect(result.current.newConnections[0].status).toBe('possible');
    });
  });

  describe('handleTagClick', () => {
    it('adds tag to activeTags', () => {
      const { result } = renderHook(() => useConnectionsManager(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.handleTagClick('tech');
      });

      expect(result.current.activeTags).toContain('tech');
    });

    it('removes tag if already active', () => {
      const { result } = renderHook(() => useConnectionsManager(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.handleTagClick('tech');
      });
      act(() => {
        result.current.handleTagClick('tech');
      });

      expect(result.current.activeTags).not.toContain('tech');
    });
  });

  describe('toggleConnectionSelection', () => {
    it('adds connection to selection', () => {
      const { result } = renderHook(() => useConnectionsManager(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.toggleConnectionSelection('conn-1');
      });

      expect(result.current.selectedConnections).toContain('conn-1');
      expect(result.current.selectedConnectionsCount).toBe(1);
    });

    it('removes connection if already selected', () => {
      const { result } = renderHook(() => useConnectionsManager(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.toggleConnectionSelection('conn-1');
      });
      act(() => {
        result.current.toggleConnectionSelection('conn-1');
      });

      expect(result.current.selectedConnections).not.toContain('conn-1');
    });
  });

  describe('updateConnectionStatus', () => {
    it('updates connection status in cache', async () => {
      // Use a single wrapper instance for this test so the QueryClient is shared
      const wrapper = createWrapper();
      const { result } = renderHook(() => useConnectionsManager(), { wrapper });

      await waitFor(() => {
        expect(result.current.connections.length).toBe(4);
      });

      act(() => {
        result.current.updateConnectionStatus('1', 'outgoing');
      });

      // The optimistic update should reflect immediately in the connections array
      await waitFor(() => {
        const updated = result.current.connections.find((c: Connection) => c.id === '1');
        expect(updated?.status).toBe('outgoing');
      });
    });
  });

  describe('fetchConnections', () => {
    it('handles fetch errors', async () => {
      mockGetConnectionsByStatus.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useConnectionsManager(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.connectionsLoading).toBe(false);
      });

      expect(result.current.connectionsError).toBe('Network error');
    });
  });

  describe('relationship score computation', () => {
    const mockComputeScores = lambdaApiService.computeRelationshipScores as ReturnType<
      typeof vi.fn
    >;
    const mockUseTier = useTier as ReturnType<typeof vi.fn>;

    it('triggers score computation for pro users after connections fetch', async () => {
      mockUseTier.mockReturnValue({
        isFeatureEnabled: (f: string) => f === 'relationship_strength_scoring',
        tier: 'pro',
      });

      const { result } = renderHook(() => useConnectionsManager(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.connectionsLoading).toBe(false);
      });

      // queryFn fires computeRelationshipScores as a side-effect for pro users
      await waitFor(() => {
        expect(mockComputeScores).toHaveBeenCalled();
      });
    });

    it('does not trigger score computation for free-tier users', async () => {
      mockUseTier.mockReturnValue({
        isFeatureEnabled: () => false,
        tier: 'free',
      });

      const { result } = renderHook(() => useConnectionsManager(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.connectionsLoading).toBe(false);
      });

      expect(mockComputeScores).not.toHaveBeenCalled();
    });
  });
});
