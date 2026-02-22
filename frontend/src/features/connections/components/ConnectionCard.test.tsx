import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ConnectionCard from './ConnectionCard';
import type { Connection } from '@/types';

// Mock tier context for feature-gated components
vi.mock('@/features/tier', () => ({
  useTier: () => ({
    isFeatureEnabled: (f: string) => f === 'relationship_strength_scoring',
    tier: 'pro',
  }),
  FeatureGate: ({ children, feature }: { children: React.ReactNode; feature?: string }) => {
    // Only render children when feature is enabled
    if (feature === 'relationship_strength_scoring') return <>{children}</>;
    return <>{children}</>;
  },
}));

const mockConnection: Connection = {
  id: 'dGVzdC1pZA==',
  first_name: 'Jane',
  last_name: 'Doe',
  position: 'Software Engineer',
  company: 'Acme Corp',
  location: 'San Francisco, CA',
  status: 'ally',
  messages: 5,
  tags: ['AI', 'Cloud', 'DevOps'],
};

describe('ConnectionCard', () => {
  it('should render connection name and details', () => {
    render(<ConnectionCard connection={mockConnection} />);

    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('Software Engineer')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('San Francisco, CA')).toBeInTheDocument();
  });

  it('should render status badge for ally', () => {
    render(<ConnectionCard connection={mockConnection} />);

    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('should render message count', () => {
    render(<ConnectionCard connection={mockConnection} />);

    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('should render "No messages" when count is zero', () => {
    render(<ConnectionCard connection={{ ...mockConnection, messages: 0 }} />);

    expect(screen.getByText('No messages')).toBeInTheDocument();
  });

  it('should display tags', () => {
    render(<ConnectionCard connection={mockConnection} />);

    expect(screen.getByText('AI')).toBeInTheDocument();
  });

  it('should call onMessageClick when message count is clicked', () => {
    const onMessageClick = vi.fn();
    render(<ConnectionCard connection={mockConnection} onMessageClick={onMessageClick} />);

    const messageEl = screen.getByText('5');
    fireEvent.click(messageEl);

    expect(onMessageClick).toHaveBeenCalledWith(mockConnection);
  });

  it('should show checkbox when showCheckbox is true and status is ally', () => {
    render(
      <ConnectionCard
        connection={mockConnection}
        showCheckbox={true}
        isCheckboxEnabled={true}
        isChecked={false}
        onCheckboxChange={vi.fn()}
      />
    );

    expect(
      screen.getByRole('checkbox', { name: /select jane doe for messaging/i })
    ).toBeInTheDocument();
  });

  it('should not show checkbox when status is not ally', () => {
    render(
      <ConnectionCard
        connection={{ ...mockConnection, status: 'possible' }}
        showCheckbox={true}
        isCheckboxEnabled={true}
      />
    );

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('should render initials in avatar', () => {
    render(<ConnectionCard connection={mockConnection} />);

    // Avatar shows first letters of first and last name
    expect(screen.getByText('JD')).toBeInTheDocument();
  });

  it('should render profile picture when profile_picture_url is set', () => {
    const connectionWithPic = {
      ...mockConnection,
      profile_picture_url: 'https://media.licdn.com/dms/image/test/photo.jpg',
    };
    const { container } = render(<ConnectionCard connection={connectionWithPic} />);

    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toBe('https://media.licdn.com/dms/image/test/photo.jpg');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    // Initials should not be shown
    expect(screen.queryByText('JD')).not.toBeInTheDocument();
  });

  it('should render initials when no profile_picture_url', () => {
    const { container } = render(<ConnectionCard connection={mockConnection} />);

    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByText('JD')).toBeInTheDocument();
  });

  it('should fall back to initials on image error', () => {
    const connectionWithPic = {
      ...mockConnection,
      profile_picture_url: 'https://media.licdn.com/dms/image/test/expired.jpg',
    };
    const { container } = render(<ConnectionCard connection={connectionWithPic} />);

    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    fireEvent.error(img);

    // After error, should show initials instead
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByText('JD')).toBeInTheDocument();
  });

  it('should render strength badge when score is present and feature enabled', () => {
    const connectionWithScore = {
      ...mockConnection,
      relationship_score: 72,
      score_breakdown: {
        frequency: 80,
        recency: 90,
        reciprocity: 60,
        profile_completeness: 55,
        depth: 70,
      },
    };
    render(<ConnectionCard connection={connectionWithScore} />);

    expect(screen.getByTestId('strength-badge')).toBeInTheDocument();
    expect(screen.getByText('72')).toBeInTheDocument();
  });

  it('should not render strength badge when score is undefined', () => {
    render(<ConnectionCard connection={mockConnection} />);

    expect(screen.queryByTestId('strength-badge')).not.toBeInTheDocument();
  });
});
