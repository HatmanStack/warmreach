import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Connection } from '@/shared/types';
import Dashboard from './Dashboard';
import { createAuthenticatedWrapper } from '@/test-utils';

// Mutable hook return values so individual tests can drive the connections list
// and the semantic-search state without re-mocking the modules.
type ConnectionsManagerValue = Record<string, unknown>;
type ProfileSearchValue = Record<string, unknown>;

let connectionsManagerValue: ConnectionsManagerValue;
let profileSearchValue: ProfileSearchValue;

const baseConnectionsManager = (): ConnectionsManagerValue => ({
  connections: [],
  connectionsLoading: false,
  connectionsError: null,
  selectedStatus: 'all',
  setSelectedStatus: vi.fn(),
  activeTags: [],
  connectionCounts: { total: 0 },
  selectedConnections: [],
  filteredConnections: [],
  newConnections: [],
  selectedConnectionsCount: 0,
  fetchConnections: vi.fn(),
  handleTagClick: vi.fn(),
  toggleConnectionSelection: vi.fn(),
  handleConnectionCheckboxChange: vi.fn(),
  updateConnectionStatus: vi.fn(),
});

const baseProfileSearch = (): ProfileSearchValue => ({
  searchQuery: '',
  setSearchQuery: vi.fn(),
  searchResults: [],
  isSearching: false,
  searchError: null,
  clearSearch: vi.fn(),
  isSearchActive: false,
});

// Dashboard pulls in a dozen feature modules; mock the side-effectful hooks
// and services so the smoke test stays fast and deterministic.
vi.mock('@/features/connections', async () => {
  const actual =
    await vi.importActual<typeof import('@/features/connections')>('@/features/connections');
  return {
    ...actual,
    useConnectionsManager: () => connectionsManagerValue,
    // Stub the virtualized list so tests can read exactly which connections are
    // displayed (by id) without virtualization getting in the way.
    VirtualConnectionList: ({ connections }: { connections: Connection[] }) => (
      <div data-testid="vcl">
        {connections.map((c) => (
          <span key={c.id} data-testid={`vcl-item-${c.id}`}>
            {c.id}
          </span>
        ))}
      </div>
    ),
  };
});

vi.mock('@/features/connections/hooks/useProfileSearch', () => ({
  useProfileSearch: () => profileSearchValue,
}));

vi.mock('@/features/messages', async () => {
  const actual = await vi.importActual<typeof import('@/features/messages')>('@/features/messages');
  return {
    ...actual,
    useMessageGeneration: () => ({
      isGeneratingMessages: false,
      workflowState: 'idle',
      messageModalOpen: false,
      selectedConnectionForMessages: null,
      generatedMessages: [],
      currentConnectionName: '',
      progressTracker: {
        progressState: { current: 0, total: 0, stage: 'idle' },
        loadingState: { isLoading: false },
      },
      handleMessageClick: vi.fn(),
      handleCloseMessageModal: vi.fn(),
      handleSendMessage: vi.fn(),
      handleGenerateMessages: vi.fn(),
      handleStopGeneration: vi.fn(),
      handleApproveAndNext: vi.fn(),
      handleSkipConnection: vi.fn(),
    }),
  };
});

vi.mock('@/features/search', async () => {
  const actual = await vi.importActual<typeof import('@/features/search')>('@/features/search');
  return {
    ...actual,
    useLinkedInSearch: () => ({
      isSearchingLinkedIn: false,
      searchLoading: false,
      searchError: null,
      searchInfoMessage: null,
      handleLinkedInSearch: vi.fn(),
    }),
  };
});

vi.mock('@/features/profile', async () => {
  const actual = await vi.importActual<typeof import('@/features/profile')>('@/features/profile');
  return {
    ...actual,
    useProfileInit: () => ({
      initializationMessage: null,
      initializationError: null,
      isInitializing: false,
    }),
  };
});

const conn = (id: string): Connection => ({ id, status: 'ally' }) as unknown as Connection;

describe('Dashboard page (smoke)', () => {
  const AuthenticatedWrapper = createAuthenticatedWrapper();

  beforeEach(() => {
    vi.clearAllMocks();
    connectionsManagerValue = baseConnectionsManager();
    profileSearchValue = baseProfileSearch();
  });

  const renderDashboard = () =>
    render(
      <AuthenticatedWrapper>
        <Dashboard />
      </AuthenticatedWrapper>
    );

  it('renders without crashing', () => {
    expect(() => renderDashboard()).not.toThrow();
  });

  it('renders the three top-level tab triggers', () => {
    renderDashboard();
    expect(screen.getByRole('tab', { name: /^connections$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^new connections$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^new post$/i })).toBeInTheDocument();
  });

  it('renders the sign-out control', () => {
    renderDashboard();
    expect(screen.getByTestId('sign-out-button')).toBeInTheDocument();
  });
});

describe('Dashboard connections list — semantic (pronged) search', () => {
  const AuthenticatedWrapper = createAuthenticatedWrapper();

  beforeEach(() => {
    vi.clearAllMocks();
    connectionsManagerValue = baseConnectionsManager();
    profileSearchValue = baseProfileSearch();
  });

  const renderDashboard = () =>
    render(
      <AuthenticatedWrapper>
        <Dashboard />
      </AuthenticatedWrapper>
    );

  it('shows the full status/tag-filtered list when no search is active', () => {
    connectionsManagerValue.filteredConnections = [conn('a'), conn('b')];
    connectionsManagerValue.connectionCounts = { total: 5 };

    renderDashboard();

    expect(screen.getByTestId('vcl-item-a')).toBeInTheDocument();
    expect(screen.getByTestId('vcl-item-b')).toBeInTheDocument();
    expect(screen.getByText('2 of 5 connections')).toBeInTheDocument();
  });

  it('intersects semantic matches with the active filter (a match outside the filter is dropped)', () => {
    // Already status/tag-filtered to {a, b}; the query semantically matches
    // {b, z}. Only b is in BOTH, so the pronged result is {b} — z (not in the
    // filtered set) must not appear.
    connectionsManagerValue.filteredConnections = [conn('a'), conn('b')];
    profileSearchValue = {
      ...baseProfileSearch(),
      isSearchActive: true,
      searchResults: [conn('b'), conn('z')],
    };

    renderDashboard();

    expect(screen.getByTestId('vcl-item-b')).toBeInTheDocument();
    expect(screen.queryByTestId('vcl-item-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vcl-item-z')).not.toBeInTheDocument();
    expect(screen.getByText('1 result')).toBeInTheDocument();
  });

  it('shows a loading state (not the empty state) while a search is in flight', () => {
    connectionsManagerValue.filteredConnections = [conn('a'), conn('b')];
    profileSearchValue = {
      ...baseProfileSearch(),
      isSearchActive: true,
      isSearching: true,
      searchResults: [],
    };

    renderDashboard();

    expect(screen.getByText(/searching your connections/i)).toBeInTheDocument();
    expect(screen.queryByTestId('vcl')).not.toBeInTheDocument();
  });

  it('shows the empty state (not loading) when a completed search matches nothing', () => {
    connectionsManagerValue.filteredConnections = [conn('a'), conn('b')];
    profileSearchValue = {
      ...baseProfileSearch(),
      isSearchActive: true,
      isSearching: false,
      searchResults: [],
    };

    renderDashboard();

    expect(screen.queryByText(/searching your connections/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('vcl')).not.toBeInTheDocument();
  });
});
