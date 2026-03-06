import React from 'react';
import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/lib/utils';

/**
 * EmptyState Component
 *
 * Provides consistent empty state messaging with optional actions
 * Used when lists are empty or no data is available
 */

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
    variant?: 'default' | 'outline' | 'secondary';
  };
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  className = '',
  size = 'md',
}) => {
  const sizeClasses = {
    sm: {
      container: 'py-8',
      icon: 'h-8 w-8 mb-3',
      title: 'text-lg',
      description: 'text-sm',
    },
    md: {
      container: 'py-12',
      icon: 'h-12 w-12 mb-4',
      title: 'text-xl',
      description: 'text-base',
    },
    lg: {
      container: 'py-16',
      icon: 'h-16 w-16 mb-6',
      title: 'text-2xl',
      description: 'text-lg',
    },
  };

  const classes = sizeClasses[size];

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        classes.container,
        className
      )}
    >
      {icon && <div className={cn('text-slate-400 opacity-50 mb-4', classes.icon)}>{icon}</div>}

      <h3 className={cn('font-medium text-slate-300 mb-2', classes.title)}>{title}</h3>

      {description && (
        <p className={cn('text-slate-400 max-w-md', classes.description)}>{description}</p>
      )}

      {action && (
        <Button
          variant={action.variant || 'outline'}
          onClick={action.onClick}
          className="mt-6 bg-slate-700 hover:bg-slate-600 text-white border-slate-600 hover:border-slate-500"
        >
          {action.label}
        </Button>
      )}
    </div>
  );
};

/**
 * NoConnectionsState Component
 *
 * Specific empty state for when no connections are found
 */
interface NoConnectionsStateProps {
  type: 'all' | 'filtered' | 'new';
  onRefresh?: () => void;
  onClearFilters?: () => void;
  className?: string;
}

export const NoConnectionsState: React.FC<NoConnectionsStateProps> = ({
  type,
  onRefresh,
  onClearFilters,
  className,
}) => {
  const getContent = () => {
    switch (type) {
      case 'all':
        return {
          title: 'No Connections Yet',
          description:
            'Start building your network by searching for new connections or importing your existing LinkedIn contacts.',
          action: onRefresh
            ? {
                label: 'Refresh',
                onClick: onRefresh,
                variant: 'outline' as const,
              }
            : undefined,
        };

      case 'filtered':
        return {
          title: 'No Connections Found',
          description:
            'No connections match your current filter. Try selecting a different status or clearing your filters.',
          action: onClearFilters
            ? {
                label: 'Clear Filters',
                onClick: onClearFilters,
                variant: 'outline' as const,
              }
            : undefined,
        };

      case 'new':
        return {
          title: 'No New Connections',
          description:
            "You're all caught up! Use the search feature above to discover new potential connections.",
          action: onRefresh
            ? {
                label: 'Refresh',
                onClick: onRefresh,
                variant: 'outline' as const,
              }
            : undefined,
        };

      default:
        return {
          title: 'No Data Available',
          description: "There's nothing to show right now.",
        };
    }
  };

  const content = getContent();

  return (
    <EmptyState
      title={content.title}
      description={content.description}
      action={content.action}
      className={className}
    />
  );
};

/**
 * NoMessagesState Component
 *
 * Specific empty state for when no messages are found
 */
interface NoMessagesStateProps {
  connectionName?: string;
  onStartConversation?: () => void;
  className?: string;
}

export const NoMessagesState: React.FC<NoMessagesStateProps> = ({
  connectionName,
  onStartConversation,
  className,
}) => {
  return (
    <EmptyState
      title="No Messages Yet"
      description={
        connectionName
          ? `Start a conversation with ${connectionName} by sending your first message.`
          : 'No message history available for this connection.'
      }
      action={
        onStartConversation
          ? {
              label: 'Start Conversation',
              onClick: onStartConversation,
              variant: 'default',
            }
          : undefined
      }
      className={className}
      size="sm"
    />
  );
};
