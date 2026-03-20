import { renderHook, act, waitFor } from '@testing-library/react';
import { useConnectionsManager } from '../useConnectionsManager';
import {
  createWrapper,
  buildConnection,
  buildMockAuthReturn,
  buildMockTierReturn,
  buildMockToastReturn,
} from '@/test-utils';
import { lambdaApiService as dbConnector, ApiError } from '@/shared/services';
import { useAuth } from '@/features/auth';
import { useTier } from '@/features/tier';
import { useToast } from '@/shared/hooks';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/features/auth');
vi.mock('@/features/tier');
vi.mock('@/shared/hooks');
vi.mock('@/shared/services', async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    lambdaApiService: {
      getConnectionsByStatus: vi.fn(),
      computeRelationshipScores: vi.fn().mockResolvedValue({}),
    },
  };
});

describe('useConnectionsManager', () => {
  const mockToast = vi.fn();
  const mockConnections = [
    buildConnection({ id: 'c1', status: 'incoming', tags: ['T1'] }),
    buildConnection({ id: 'c2', status: 'outgoing', common_interests: ['T1'] }),
    buildConnection({ id: 'c3', status: 'ally', tags: ['T2'] }),
    buildConnection({ id: 'c4', status: 'possible' }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAuth).mockReturnValue(
      buildMockAuthReturn({ user: { id: 'u1', email: 'u1@test.com' } })
    );
    vi.mocked(useTier).mockReturnValue(buildMockTierReturn());
    vi.mocked(useToast).mockReturnValue(buildMockToastReturn(mockToast));
    vi.mocked(dbConnector.getConnectionsByStatus).mockResolvedValue(mockConnections);
  });

  const Wrapper = createWrapper();

  it('should load connections and calculate counts', async () => {
    const { result } = renderHook(() => useConnectionsManager(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.connections).toHaveLength(4);
    });

    expect(result.current.connectionCounts).toEqual({
      incoming: 1,
      outgoing: 1,
      ally: 1,
      total: 3, // only counts incoming/outgoing/ally in total per code
    });
  });

  it('should trigger score computation for pro users', async () => {
    vi.mocked(useTier).mockReturnValue(
      buildMockTierReturn({ isFeatureEnabled: vi.fn().mockReturnValue(true) })
    );
    vi.mocked(useAuth).mockReturnValue(
      buildMockAuthReturn({ user: { id: 'u-pro', email: 'pro@test.com' } })
    );

    renderHook(() => useConnectionsManager(), { wrapper: createWrapper() });

    await waitFor(
      () => {
        expect(dbConnector.computeRelationshipScores).toHaveBeenCalled();
      },
      { timeout: 2000 }
    );
  });

  it('should filter connections by status', async () => {
    const { result } = renderHook(() => useConnectionsManager(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.connections.length).toBeGreaterThan(0));

    act(() => {
      result.current.setSelectedStatus('incoming');
    });

    expect(result.current.filteredConnections).toHaveLength(1);
    expect(result.current.filteredConnections[0].id).toBe('c1');

    act(() => {
      result.current.setSelectedStatus('all');
    });
    expect(result.current.filteredConnections).toHaveLength(3); // excludes 'possible'
  });

  it('should filter and sort by active tags', async () => {
    const { result } = renderHook(() => useConnectionsManager(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.connections.length).toBeGreaterThan(0));

    act(() => {
      result.current.handleTagClick('T1');
    });

    expect(result.current.activeTags).toEqual(['T1']);
    // c1 and c2 have T1, c3 does not.
    // They should be at the top.
    expect(result.current.filteredConnections[0].id).toMatch(/c1|c2/);
    expect(result.current.filteredConnections[1].id).toMatch(/c1|c2/);
    expect(result.current.filteredConnections[2].id).toBe('c3');
  });

  it('should handle connection selection', () => {
    const { result } = renderHook(() => useConnectionsManager(), { wrapper: Wrapper });

    act(() => {
      result.current.toggleConnectionSelection('c1');
    });
    expect(result.current.selectedConnections).toEqual(['c1']);
    expect(result.current.selectedConnectionsCount).toBe(1);

    act(() => {
      result.current.toggleConnectionSelection('c1');
    });
    expect(result.current.selectedConnections).toEqual([]);

    act(() => {
      result.current.handleConnectionCheckboxChange('c2', true);
    });
    expect(result.current.selectedConnections).toEqual(['c2']);

    act(() => {
      result.current.handleConnectionCheckboxChange('c2', true); // already there
    });
    expect(result.current.selectedConnections).toEqual(['c2']);

    act(() => {
      result.current.handleConnectionCheckboxChange('c2', false);
    });
    expect(result.current.selectedConnections).toEqual([]);
  });

  it('should update connection status optimistically', async () => {
    const { result } = renderHook(() => useConnectionsManager(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.connections.length).toBeGreaterThan(0));

    act(() => {
      result.current.updateConnectionStatus('c1', 'ally');
    });

    await waitFor(() => {
      expect(result.current.connections.find((c) => c.id === 'c1')?.status).toBe('ally');
    });
  });

  it('should handle fetch errors with toast', async () => {
    const error = new ApiError({ message: 'Failed', status: 500 });
    // We need to mock the refetch specifically
    // But fetchConnections in hook comes from useQuery result.
    // The hook calls fetchConnectionsWithErrorHandling which calls fetchConnections()

    // Instead of mocking internal fetchConnections, we'll test the wrapper's behavior
    // by making queryFn fail.
    vi.mocked(dbConnector.getConnectionsByStatus).mockRejectedValueOnce(error);

    const { result } = renderHook(() => useConnectionsManager(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.fetchConnections();
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Failed to Load Connections',
        description: 'Failed',
      })
    );
  });

  it('should not compute scores if already triggered or disabled', async () => {
    const isFeatureEnabled = vi.fn().mockReturnValue(false);
    vi.mocked(useTier).mockReturnValue(buildMockTierReturn({ isFeatureEnabled }));

    const { result } = renderHook(() => useConnectionsManager(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.computeScores();
    });

    expect(dbConnector.computeRelationshipScores).not.toHaveBeenCalled();
  });
});
