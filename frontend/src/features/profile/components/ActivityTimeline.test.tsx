import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActivityTimeline } from './ActivityTimeline';
import { formatActivityDescription, formatRelativeTime } from '../utils/activityHelpers';
import { activityApiService } from '@/shared/services/activityApiService';

vi.mock('@/shared/services/activityApiService', () => ({
  activityApiService: {
    getActivityTimeline: vi.fn(),
  },
}));

vi.mock('@/features/auth', () => ({
  useAuth: () => ({ user: { id: 'test-user-123', email: 'test@example.com' } }),
}));

function createTestWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('ActivityTimeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render loading state initially', () => {
    vi.mocked(activityApiService.getActivityTimeline).mockReturnValue(new Promise(() => {}));

    render(<ActivityTimeline />, { wrapper: createTestWrapper() });

    expect(screen.getByTestId('loading-state')).toBeInTheDocument();
  });

  it('should render activity events from mock data', async () => {
    vi.mocked(activityApiService.getActivityTimeline).mockResolvedValue({
      activities: [
        { eventType: 'message_sent', timestamp: '2024-01-01T10:00:00Z' },
        {
          eventType: 'connection_status_change',
          timestamp: '2024-01-01T09:00:00Z',
          metadata: { status: 'ally' },
        },
      ],
      nextCursor: null,
      count: 2,
    });

    render(<ActivityTimeline />, { wrapper: createTestWrapper() });

    const items = await screen.findAllByTestId('activity-item');
    expect(items).toHaveLength(2);
    expect(screen.getByText('Message sent')).toBeInTheDocument();
    expect(screen.getByText('Connection status changed to ally')).toBeInTheDocument();
  });

  it('should render empty state when no activities', async () => {
    vi.mocked(activityApiService.getActivityTimeline).mockResolvedValue({
      activities: [],
      nextCursor: null,
      count: 0,
    });

    render(<ActivityTimeline />, { wrapper: createTestWrapper() });

    expect(await screen.findByTestId('empty-state')).toBeInTheDocument();
  });

  it('should render category filter buttons', async () => {
    vi.mocked(activityApiService.getActivityTimeline).mockResolvedValue({
      activities: [],
      nextCursor: null,
      count: 0,
    });

    render(<ActivityTimeline />, { wrapper: createTestWrapper() });

    expect(screen.getByTestId('filter-All')).toBeInTheDocument();
    expect(screen.getByTestId('filter-Connections')).toBeInTheDocument();
    expect(screen.getByTestId('filter-Messages')).toBeInTheDocument();
    expect(screen.getByTestId('filter-AI')).toBeInTheDocument();
    expect(screen.getByTestId('filter-Commands')).toBeInTheDocument();
  });

  it('should change selected filter when category button is clicked', async () => {
    vi.mocked(activityApiService.getActivityTimeline).mockResolvedValue({
      activities: [],
      nextCursor: null,
      count: 0,
    });

    render(<ActivityTimeline />, { wrapper: createTestWrapper() });

    await screen.findByTestId('empty-state');

    fireEvent.click(screen.getByTestId('filter-Messages'));

    // After clicking, the service should be called with eventType filter
    expect(activityApiService.getActivityTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'message_sent' })
    );
  });

  it('should show Load More button when hasNextPage', async () => {
    vi.mocked(activityApiService.getActivityTimeline).mockResolvedValue({
      activities: [{ eventType: 'message_sent', timestamp: '2024-01-01T10:00:00Z' }],
      nextCursor: 'cursor-token',
      count: 1,
    });

    render(<ActivityTimeline />, { wrapper: createTestWrapper() });

    expect(await screen.findByTestId('load-more-button')).toBeInTheDocument();
  });
});

describe('formatActivityDescription', () => {
  it('should format connection_status_change with status', () => {
    expect(
      formatActivityDescription({
        eventType: 'connection_status_change',
        timestamp: '2024-01-01T10:00:00Z',
        metadata: { status: 'ally' },
      })
    ).toBe('Connection status changed to ally');
  });

  it('should format connection_status_change without status', () => {
    expect(
      formatActivityDescription({
        eventType: 'connection_status_change',
        timestamp: '2024-01-01T10:00:00Z',
        metadata: { profileId: 'p1' },
      })
    ).toBe('Connection updated: p1');
  });

  it('should format message_sent', () => {
    expect(
      formatActivityDescription({ eventType: 'message_sent', timestamp: '2024-01-01T10:00:00Z' })
    ).toBe('Message sent');
  });

  it('should format command_dispatched', () => {
    expect(
      formatActivityDescription({
        eventType: 'command_dispatched',
        timestamp: '2024-01-01T10:00:00Z',
        metadata: { commandType: 'scrape' },
      })
    ).toBe('Command dispatched: scrape');
  });

  it('should format ai_message_generated', () => {
    expect(
      formatActivityDescription({
        eventType: 'ai_message_generated',
        timestamp: '2024-01-01T10:00:00Z',
      })
    ).toBe('AI message generated');
  });

  it('should format note_added', () => {
    expect(
      formatActivityDescription({ eventType: 'note_added', timestamp: '2024-01-01T10:00:00Z' })
    ).toBe('Note added');
  });

  it('should return eventType for unknown types', () => {
    expect(
      formatActivityDescription({ eventType: 'custom_event', timestamp: '2024-01-01T10:00:00Z' })
    ).toBe('custom_event');
  });
});

describe('formatRelativeTime', () => {
  it('should return "Just now" for recent timestamps', () => {
    const now = new Date();
    expect(formatRelativeTime(now.toISOString())).toBe('Just now');
  });

  it('should return minutes ago for timestamps within an hour', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatRelativeTime(fiveMinutesAgo.toISOString())).toBe('5 minutes ago');
  });

  it('should return hours ago for timestamps within a day', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000);
    expect(formatRelativeTime(threeHoursAgo.toISOString())).toBe('3 hours ago');
  });

  it('should return "Yesterday" for one day ago', () => {
    const oneDayAgo = new Date(Date.now() - 1 * 86400 * 1000);
    expect(formatRelativeTime(oneDayAgo.toISOString())).toBe('Yesterday');
  });

  it('should return days ago for timestamps within a week', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400 * 1000);
    expect(formatRelativeTime(threeDaysAgo.toISOString())).toBe('3 days ago');
  });

  it('should return formatted date for timestamps older than a week', () => {
    const oldDate = new Date('2023-01-15T10:00:00Z');
    const result = formatRelativeTime(oldDate.toISOString());
    // Should be a date string, not a relative time
    expect(result).not.toContain('ago');
    expect(result).not.toBe('Just now');
  });
});
