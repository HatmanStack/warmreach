import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Search, Archive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import NewConnectionCard from './NewConnectionCard';
import type { ConnectionRunGroup } from '../utils/connectionGrouping';
import type { Connection } from '@/types';

// Render this many cards per group initially; the rest load on demand. Without
// this cap an expanded group renders every card at once, so a broad search
// (hundreds of contacts) that auto-expands would mount them all synchronously
// and freeze the tab — the windowing the old VirtualConnectionList provided.
const PAGE_SIZE = 30;

interface NewConnectionGroupProps {
  group: ConnectionRunGroup;
  isExpanded: boolean;
  onToggle: (key: string) => void;
  onRemove: (connectionId: string, newStatus: string) => void;
  onSelect?: (connection: Connection) => void;
  onTagClick?: (tag: string) => void;
  activeTags?: string[];
}

/** Format the group's most-recent find date as a compact "Jul 15" label. */
function formatLatest(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * A collapsible section grouping "possible" connections that were surfaced by
 * one LinkedIn search run. The header shows the search terms, how many contacts
 * it produced, and when the most recent was found.
 */
const NewConnectionGroup: React.FC<NewConnectionGroupProps> = ({
  group,
  isExpanded,
  onToggle,
  onRemove,
  onSelect,
  onTagClick,
  activeTags = [],
}) => {
  const latest = formatLatest(group.latestDate);
  const Chevron = isExpanded ? ChevronDown : ChevronRight;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const visible = group.connections.slice(0, visibleCount);
  const remaining = group.connections.length - visible.length;

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 overflow-hidden">
      <button
        type="button"
        onClick={() => onToggle(group.key)}
        aria-expanded={isExpanded}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-white/5 transition-colors"
      >
        <Chevron className="h-4 w-4 text-slate-400 flex-shrink-0" />
        {group.isUngrouped ? (
          <Archive className="h-4 w-4 text-slate-500 flex-shrink-0" />
        ) : (
          <Search className="h-4 w-4 text-teal-400 flex-shrink-0" />
        )}
        <span className="text-white font-medium truncate">{group.label}</span>
        <span className="text-slate-400 text-sm flex-shrink-0">
          · {group.count} found{latest && !group.isUngrouped ? ` · latest ${latest}` : ''}
        </span>
      </button>

      {isExpanded && (
        <div className="px-4 pb-3">
          {visible.map((connection) => (
            <NewConnectionCard
              key={connection.id}
              connection={connection}
              onRemove={onRemove}
              onSelect={onSelect}
              onTagClick={onTagClick}
              activeTags={activeTags}
            />
          ))}
          {remaining > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              className="mt-2 w-full text-slate-300 hover:text-white"
            >
              Show {Math.min(remaining, PAGE_SIZE)} more ({remaining} remaining)
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

export default NewConnectionGroup;
