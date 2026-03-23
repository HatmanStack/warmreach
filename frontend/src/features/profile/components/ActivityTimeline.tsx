import React, { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Users, MessageSquare, Sparkles, Terminal, Loader2 } from 'lucide-react';
import { useAuth } from '@/features/auth';
import { activityApiService } from '@/shared/services/activityApiService';
import { queryKeys } from '@/shared/lib/queryKeys';
import { formatActivityDescription, formatRelativeTime } from '../utils/activityHelpers';
import type { ActivityCategory } from '@/shared/types';

// =============================================================================
// CONSTANTS
// =============================================================================

const CATEGORY_EVENT_TYPE_MAP: Record<ActivityCategory | 'All', string[] | undefined> = {
  All: undefined,
  Connections: ['connection_status_change'],
  Messages: ['message_sent'],
  AI: ['ai_message_generated', 'ai_tone_analysis', 'ai_deep_research'],
  Commands: ['command_dispatched'],
};

const CATEGORY_ICONS: Record<string, React.FC<{ className?: string }>> = {
  connection_status_change: Users,
  message_sent: MessageSquare,
  ai_message_generated: Sparkles,
  ai_tone_analysis: Sparkles,
  ai_deep_research: Sparkles,
  command_dispatched: Terminal,
  note_added: MessageSquare,
  user_settings_updated: Users,
  profile_metadata_updated: Users,
  profile_ingested: Users,
};

function getEventIcon(eventType: string): React.FC<{ className?: string }> {
  return CATEGORY_ICONS[eventType] || Terminal;
}

const CATEGORIES: (ActivityCategory | 'All')[] = [
  'All',
  'Connections',
  'Messages',
  'AI',
  'Commands',
];

// =============================================================================
// COMPONENT
// =============================================================================

export const ActivityTimeline: React.FC = () => {
  const { user } = useAuth();
  const userId = user?.id ?? 'current';
  const [selectedCategory, setSelectedCategory] = useState<ActivityCategory | 'All'>('All');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  const eventTypes = CATEGORY_EVENT_TYPE_MAP[selectedCategory];

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError } =
    useInfiniteQuery({
      queryKey: [...queryKeys.activity.timeline(userId), selectedCategory, startDate, endDate],
      queryFn: ({ pageParam }) =>
        activityApiService.getActivityTimeline({
          eventType: eventTypes?.length === 1 ? eventTypes[0] : undefined,
          eventTypes: eventTypes && eventTypes.length > 1 ? eventTypes : undefined,
          startDate: startDate || undefined,
          endDate: endDate || undefined,
          limit: 20,
          cursor: pageParam as string | undefined,
        }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    });

  const activities = data?.pages.flatMap((page) => page.activities) ?? [];

  return (
    <div data-testid="activity-timeline">
      <h3 className="text-lg font-semibold text-white mb-4">Activity Timeline</h3>

      {/* Category filter buttons */}
      <div className="flex flex-wrap gap-2 mb-4" data-testid="category-filters">
        {CATEGORIES.map((category) => (
          <Button
            key={category}
            variant={selectedCategory === category ? 'default' : 'outline'}
            size="sm"
            onClick={() => setSelectedCategory(category)}
            data-testid={`filter-${category}`}
            className={
              selectedCategory === category
                ? 'bg-blue-600 hover:bg-blue-700 text-white'
                : 'border-white/20 text-slate-300 hover:bg-white/10'
            }
          >
            {category}
          </Button>
        ))}
      </div>

      {/* Date range picker */}
      <div className="flex gap-2 mb-4" data-testid="date-range-picker">
        <Input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="bg-white/5 border-white/20 text-white w-auto"
          aria-label="Start date"
        />
        <Input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          className="bg-white/5 border-white/20 text-white w-auto"
          aria-label="End date"
        />
      </div>

      {/* Loading state */}
      {isLoading && (
        <div data-testid="loading-state" className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-blue-400" />
          <span className="ml-2 text-slate-300">Loading activity...</span>
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div data-testid="error-state" className="text-red-400 text-center py-8">
          Failed to load activity timeline. Please try again.
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !isError && activities.length === 0 && (
        <div data-testid="empty-state" className="text-slate-400 text-center py-8">
          No activity found for the selected filters.
        </div>
      )}

      {/* Activity list */}
      {activities.length > 0 && (
        <div className="space-y-2" data-testid="activity-list">
          {activities.map((event, index) => {
            const IconComponent = getEventIcon(event.eventType);
            return (
              <div
                key={`${event.timestamp}-${event.eventType}-${index}`}
                data-testid="activity-item"
                className="flex items-start gap-3 p-3 bg-white/5 rounded-lg border border-white/10"
              >
                <div className="mt-0.5">
                  <IconComponent className="h-4 w-4 text-blue-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-200">{formatActivityDescription(event)}</p>
                  <p className="text-xs text-slate-400 mt-1">
                    {formatRelativeTime(event.timestamp)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Load more button */}
      {hasNextPage && (
        <div className="mt-4 text-center">
          <Button
            data-testid="load-more-button"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            variant="outline"
            className="border-white/20 text-slate-300 hover:bg-white/10"
          >
            {isFetchingNextPage ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Loading...
              </>
            ) : (
              'Load More'
            )}
          </Button>
        </div>
      )}
    </div>
  );
};
