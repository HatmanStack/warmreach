import { render, screen } from '@testing-library/react';
import VirtualConnectionList from '../VirtualConnectionList';
import { buildConnection, createAuthenticatedWrapper } from '@/test-utils';
import { describe, it, expect, vi } from 'vitest';

// Mock useVirtualizer
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn().mockReturnValue({
    getVirtualItems: () => [
      { index: 0, key: 'c1', start: 0 },
      { index: 1, key: 'c2', start: 160 },
    ],
    getTotalSize: () => 320,
    measureElement: vi.fn(),
  }),
}));

// Mock useReplyProbabilities
vi.mock('../hooks/useReplyProbabilities', () => ({
  useReplyProbabilities: vi.fn().mockReturnValue({
    probabilityMap: {},
    loading: false,
  }),
}));

describe('VirtualConnectionList', () => {
  const mockConnections = [
    buildConnection({ id: 'c1', first_name: 'John' }),
    buildConnection({ id: 'c2', first_name: 'Jane' }),
  ];

  const AuthenticatedWrapper = createAuthenticatedWrapper();

  it('should render connections list', () => {
    render(
      <AuthenticatedWrapper>
        <VirtualConnectionList connections={mockConnections} />
      </AuthenticatedWrapper>
    );

    expect(screen.getByText(/John/i)).toBeInTheDocument();
    expect(screen.getByText(/Jane/i)).toBeInTheDocument();
  });

  it('should show empty state when no connections', () => {
    render(
      <AuthenticatedWrapper>
        <VirtualConnectionList connections={[]} />
      </AuthenticatedWrapper>
    );

    expect(screen.getByText(/no connections found/i)).toBeInTheDocument();
  });

  it('should show filtered empty state when filters return nothing', () => {
    render(
      <AuthenticatedWrapper>
        <VirtualConnectionList
          connections={mockConnections}
          initialFilters={{ searchTerm: 'nonexistent' }}
        />
      </AuthenticatedWrapper>
    );

    expect(screen.getByText(/no connections match your filters/i)).toBeInTheDocument();
  });
});
