import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import ConnectionCard from './ConnectionCard';
import NewConnectionCard from './NewConnectionCard';
import ConnectionFiltersComponent from './ConnectionFilters';
import { filterConnections, sortConnections } from '@/features/connections';
import type { Connection, ConnectionFilters } from '@/types';

interface VirtualConnectionListProps {
  connections: Connection[];
  isNewConnection?: boolean;
  onSelect?: (connectionId: string) => void;
  onNewConnectionClick?: (connection: Connection) => void;
  onRemove?: (connectionId: string, newStatus: string) => void;
  onTagClick?: (tag: string) => void;
  onMessageClick?: (connection: Connection) => void;
  activeTags?: string[];
  selectedConnectionId?: string;
  className?: string;
  itemHeight?: number;
  overscanCount?: number;
  showFilters?: boolean;
  initialFilters?: ConnectionFilters;
  sortBy?: 'name' | 'company' | 'date_added' | 'conversion_likelihood' | 'strength';
  sortOrder?: 'asc' | 'desc';
  showCheckboxes?: boolean;
  selectedConnections?: string[];
  onCheckboxChange?: (connectionId: string, checked: boolean) => void;
}

const VirtualConnectionList: React.FC<VirtualConnectionListProps> = ({
  connections,
  isNewConnection = false,
  onSelect,
  onNewConnectionClick,
  onRemove,
  onTagClick,
  onMessageClick,
  activeTags = [],
  selectedConnectionId,
  className = '',
  itemHeight = 160,
  overscanCount = 20,
  showFilters = true,
  initialFilters = {},
  sortBy = 'name',
  sortOrder = 'asc',
  showCheckboxes = false,
  selectedConnections = [],
  onCheckboxChange,
}) => {
  const parentRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState(600);
  const [filters, setFilters] = useState<ConnectionFilters>(initialFilters);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());

  // Compute container height from viewport
  useEffect(() => {
    const measure = () => {
      if (parentRef.current) {
        const rect = parentRef.current.getBoundingClientRect();
        const available = window.innerHeight - rect.top - 40;
        setContainerHeight(Math.max(500, available));
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Apply filters and sorting
  const processedConnections = useMemo(() => {
    let filtered = filterConnections(connections, filters);
    if (removedIds.size > 0) {
      filtered = filtered.filter((c: Connection) => !removedIds.has(c.id));
    }
    if (activeTags && activeTags.length > 0) {
      return filtered;
    }
    return sortConnections(filtered, sortBy, sortOrder);
  }, [connections, filters, sortBy, sortOrder, removedIds, activeTags]);

  const virtualizer = useVirtualizer({
    count: processedConnections.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => itemHeight,
    overscan: overscanCount,
  });

  const handleFiltersChange = useCallback((newFilters: ConnectionFilters) => {
    setFilters(newFilters);
  }, []);

  const handleRemoveInternal = useCallback(
    (connectionId: string, newStatus: string) => {
      setRemovedIds((prev) => {
        const next = new Set(prev);
        next.add(connectionId);
        return next;
      });
      if (onRemove) onRemove(connectionId, newStatus);
    },
    [onRemove]
  );

  return (
    <div className={`w-full space-y-4 ${className}`}>
      {showFilters && (
        <ConnectionFiltersComponent
          connections={connections}
          filters={filters}
          onFiltersChange={handleFiltersChange}
          isNewConnection={isNewConnection}
          className="mb-4"
        />
      )}

      {showFilters && (
        <div className="flex items-center justify-between text-sm text-slate-400 px-1">
          <span>
            Showing {processedConnections.length} of {connections.length} connection
            {connections.length !== 1 ? 's' : ''}
          </span>
          {Object.keys(filters).length > 0 && (
            <span className="text-blue-400">
              {Object.keys(filters).length} filter{Object.keys(filters).length !== 1 ? 's' : ''}{' '}
              active
            </span>
          )}
        </div>
      )}

      <div
        ref={parentRef}
        style={{ height: containerHeight }}
        className="overflow-auto scrollbar-thin scrollbar-thumb-slate-600 scrollbar-track-slate-800"
      >
        {processedConnections.length === 0 ? (
          <div className="flex items-center justify-center h-64 text-slate-400">
            <div className="text-center">
              <p className="text-lg mb-2">
                {connections.length === 0
                  ? 'No connections found'
                  : 'No connections match your filters'}
              </p>
              <p className="text-sm">
                {connections.length === 0
                  ? isNewConnection
                    ? 'No new connections available at the moment.'
                    : 'Try checking back later or adding some connections.'
                  : 'Try adjusting your filters to see more results.'}
              </p>
            </div>
          </div>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const connection = processedConnections[virtualRow.index];
              if (!connection) return null;

              return (
                <div
                  key={connection.id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className="px-2"
                >
                  {isNewConnection ? (
                    <NewConnectionCard
                      connection={connection}
                      onRemove={handleRemoveInternal}
                      onSelect={onNewConnectionClick}
                      onTagClick={onTagClick}
                      activeTags={activeTags}
                    />
                  ) : (
                    <ConnectionCard
                      connection={connection}
                      isSelected={selectedConnectionId === connection.id}
                      isNewConnection={isNewConnection}
                      onSelect={onSelect}
                      onNewConnectionClick={onNewConnectionClick}
                      onTagClick={onTagClick}
                      onMessageClick={onMessageClick}
                      activeTags={activeTags}
                      showCheckbox={showCheckboxes}
                      isCheckboxEnabled={connection.status === 'ally'}
                      isChecked={selectedConnections?.includes(connection.id) || false}
                      onCheckboxChange={onCheckboxChange}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default VirtualConnectionList;
