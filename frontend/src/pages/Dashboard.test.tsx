import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Dashboard from './Dashboard';
import { createAuthenticatedWrapper } from '@/test-utils';

// Dashboard pulls in a dozen feature modules; mock the side-effectful hooks
// and services so the smoke test stays fast and deterministic.
vi.mock('@/features/connections', async () => {
  const actual =
    await vi.importActual<typeof import('@/features/connections')>('@/features/connections');
  return {
    ...actual,
    useConnectionsManager: () => ({
      connections: [],
      connectionsLoading: false,
      connectionsError: null,
      selectedStatus: 'all',
      setSelectedStatus: vi.fn(),
      activeTags: [],
      connectionCounts: {},
      selectedConnections: [],
      filteredConnections: [],
      newConnections: [],
      selectedConnectionsCount: 0,
      fetchConnections: vi.fn(),
      handleTagClick: vi.fn(),
      toggleConnectionSelection: vi.fn(),
      handleConnectionCheckboxChange: vi.fn(),
      updateConnectionStatus: vi.fn(),
    }),
  };
});

vi.mock('@/features/workflow', async () => {
  const actual = await vi.importActual<typeof import('@/features/workflow')>('@/features/workflow');
  return {
    ...actual,
    useHealAndRestore: () => ({
      startListening: vi.fn(),
      stopListening: vi.fn(),
      isListening: false,
    }),
  };
});

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

describe('Dashboard page (smoke)', () => {
  const AuthenticatedWrapper = createAuthenticatedWrapper();

  beforeEach(() => {
    vi.clearAllMocks();
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
