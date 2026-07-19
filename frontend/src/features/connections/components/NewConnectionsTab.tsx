import type React from 'react';
import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { UserPlus, Building, User, Search, Loader2, AlertCircle, Info } from 'lucide-react';
import { filterConnections, groupConnectionsByRun } from '@/features/connections';
import ConnectionFiltersComponent from './ConnectionFilters';
import NewConnectionGroup from './NewConnectionGroup';
import { ConnectionSearchBar } from './ConnectionSearchBar';
import type { Connection, ConnectionFilters } from '@/types';

interface NewConnectionsTabProps {
  searchResults: Connection[];
  onSearch: (filters: { company: string; job: string; location: string; userId: string }) => void;
  isSearching: boolean;
  userId: string;
  connectionsLoading?: boolean;
  connectionsError?: string | null;
  searchInfoMessage?: string | null;
  onRefresh?: () => void;
  onRemoveConnection?: (connectionId: string, newStatus: 'processed' | 'outgoing') => void;
}

const NewConnectionsTab = ({
  searchResults,
  onSearch,
  isSearching,
  userId,
  connectionsLoading = false,
  connectionsError = null,
  searchInfoMessage = null,
  onRefresh,
  onRemoveConnection,
}: NewConnectionsTabProps) => {
  const [searchFilters, setSearchFilters] = useState({
    company: '',
    job: '',
    location: '',
  });
  const [activeTags, setActiveTags] = useState<string[]>([]);

  // Popover filters (company / location / conversion) applied within groups.
  const [filters, setFilters] = useState<ConnectionFilters>({});

  // Locally hide cards the user removes/connects so they vanish immediately,
  // before the parent's React Query cache refetches.
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());

  // Which run groups are expanded. The newest run auto-expands (see effect).
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const autoExpandedRef = useRef<string | null>(null);

  // Local search query state for client-side filtering
  // Note: NewConnections shows "possible" contacts which are NOT ingested into RAGStack
  // per ADR-007, so we use client-side filtering instead of semantic search
  const [searchQuery, setSearchQuery] = useState('');

  // Only "possible" contacts belong in this discovery view.
  const possibleConnections = useMemo(
    () => searchResults.filter((connection) => connection.status === 'possible'),
    [searchResults]
  );

  // Full filter pipeline: drop removed → popover filters → text query.
  const displayResults = useMemo(() => {
    let result = possibleConnections;
    if (removedIds.size > 0) {
      result = result.filter((c) => !removedIds.has(c.id));
    }
    if (Object.keys(filters).length > 0) {
      result = filterConnections(result, filters);
    }
    const query = searchQuery.toLowerCase().trim();
    if (query) {
      result = result.filter(
        (c) =>
          c.first_name?.toLowerCase().includes(query) ||
          c.last_name?.toLowerCase().includes(query) ||
          c.company?.toLowerCase().includes(query) ||
          c.position?.toLowerCase().includes(query) ||
          c.headline?.toLowerCase().includes(query)
      );
    }
    return result;
  }, [possibleConnections, removedIds, filters, searchQuery]);

  // Group the visible contacts by the search run that surfaced them.
  const groups = useMemo(() => groupConnectionsByRun(displayResults), [displayResults]);

  const totalShown = displayResults.length;

  // Auto-expand the newest run whenever it changes (initial load or a fresh
  // search landing), without collapsing anything the user opened manually.
  useEffect(() => {
    const newest = groups.find((g) => !g.isUngrouped) ?? groups[0];
    if (newest && autoExpandedRef.current !== newest.key) {
      autoExpandedRef.current = newest.key;
      setExpandedKeys((prev) => new Set(prev).add(newest.key));
    }
  }, [groups]);

  const handleSearch = () => {
    onSearch({
      ...searchFilters,
      userId,
    });
  };

  const clearSearch = () => {
    setSearchQuery('');
  };

  const toggleGroup = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // Handle connection removal - hide locally and inform the parent so its
  // React Query source-of-truth updates.
  const handleRemoveConnection = useCallback(
    (connectionId: string, newStatus: string) => {
      setRemovedIds((prev) => new Set(prev).add(connectionId));
      if (onRemoveConnection && (newStatus === 'processed' || newStatus === 'outgoing')) {
        onRemoveConnection(connectionId, newStatus);
      }
    },
    [onRemoveConnection]
  );

  // Handle tag clicks (visual highlight across cards)
  const handleTagClick = useCallback((tag: string) => {
    setActiveTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }, []);

  const isSearchActive = searchQuery.trim().length > 0;

  return (
    <div className="grid lg:grid-cols-4 gap-8">
      <div className="lg:col-span-3">
        <Card className="bg-white/5 backdrop-blur-md border-white/10">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-white flex items-center">
                <UserPlus className="h-5 w-5 mr-2" />
                Discover New Connections ({totalShown})
              </CardTitle>
              <ConnectionFiltersComponent
                connections={possibleConnections}
                filters={filters}
                onFiltersChange={setFilters}
                isNewConnection={true}
              />
            </div>

            {/* Client-side Search Bar */}
            <div className="mt-4 space-y-3">
              <ConnectionSearchBar
                value={searchQuery}
                onChange={setSearchQuery}
                onClear={clearSearch}
                isLoading={false} // Client-side search is instant, no loading state
                placeholder="Filter new connections by name, company, position..."
              />

              {/* Empty Search Results */}
              {isSearchActive && totalShown === 0 && (
                <div className="bg-slate-700/30 border border-slate-600/30 rounded-lg p-4 text-center">
                  <p className="text-slate-300 mb-2">No matches found for "{searchQuery}"</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearSearch}
                    className="text-blue-400 hover:text-blue-300"
                  >
                    Clear search
                  </Button>
                </div>
              )}
            </div>

            {/* LinkedIn Search Filters */}
            <div className="grid grid-cols-3 gap-4 mt-4">
              <div className="relative">
                <Building className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                <Input
                  placeholder="Company"
                  value={searchFilters.company}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setSearchFilters((prev) => ({ ...prev, company: e.target.value }))
                  }
                  className="pl-10 bg-white/5 border-white/20 text-white placeholder-slate-400"
                />
              </div>
              <div className="relative">
                <User className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                <Input
                  placeholder="Job Title"
                  value={searchFilters.job}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setSearchFilters((prev) => ({ ...prev, job: e.target.value }))
                  }
                  className="pl-10 bg-white/5 border-white/20 text-white placeholder-slate-400"
                />
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                <Input
                  placeholder="Location"
                  value={searchFilters.location}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setSearchFilters((prev) => ({ ...prev, location: e.target.value }))
                  }
                  className="pl-10 bg-white/5 border-white/20 text-white placeholder-slate-400"
                />
              </div>
            </div>

            {/* Search Info Message Banner */}
            {searchInfoMessage && (
              <Alert className="mt-4 bg-blue-500/10 border-blue-500/30">
                <Info className="h-4 w-4 text-blue-400" />
                <AlertDescription className="text-blue-200">{searchInfoMessage}</AlertDescription>
              </Alert>
            )}
          </CardHeader>
          <CardContent className="p-2 pt-4">
            {/* Loading State */}
            {connectionsLoading && (
              <div className="flex items-center justify-center h-64 p-6">
                <div className="flex flex-col items-center space-y-4">
                  <Loader2 className="h-8 w-8 animate-spin text-blue-400" />
                  <p className="text-slate-300">Loading new connections...</p>
                </div>
              </div>
            )}

            {/* Error State */}
            {connectionsError && !connectionsLoading && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-6 m-6">
                <div className="flex items-center space-x-3">
                  <AlertCircle className="h-5 w-5 text-red-400 flex-shrink-0" />
                  <div>
                    <h3 className="text-red-300 font-medium">Failed to Load New Connections</h3>
                    <p className="text-red-400 text-sm mt-1">{connectionsError}</p>
                    {onRefresh && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3 border-red-500/30 text-red-300 hover:bg-red-500/10"
                        onClick={onRefresh}
                      >
                        Try Again
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Grouped new connections */}
            {!connectionsLoading && !connectionsError && (
              <>
                {totalShown === 0 ? (
                  <div className="flex items-center justify-center h-64 text-slate-400 p-6">
                    <div className="text-center">
                      <UserPlus className="h-12 w-12 mx-auto mb-4 opacity-50" />
                      <p className="text-lg mb-2">No new connections available</p>
                      <p className="text-sm">
                        {isSearchActive
                          ? 'Try a different search query or clear the search.'
                          : 'Check back later or use the search above to find new connections.'}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 space-y-3">
                    {groups.map((group) => (
                      <NewConnectionGroup
                        key={group.key}
                        group={group}
                        isExpanded={expandedKeys.has(group.key)}
                        onToggle={toggleGroup}
                        onRemove={handleRemoveConnection}
                        onTagClick={handleTagClick}
                        activeTags={activeTags}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <Card className="bg-white/5 backdrop-blur-md border-white/10">
          <CardHeader>
            <CardTitle className="text-white">Search Filters</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              onClick={handleSearch}
              disabled={isSearching}
              className="w-full bg-gradient-to-r from-green-600 to-teal-600 hover:from-green-700 hover:to-teal-700 text-white"
            >
              <Search className="h-4 w-4 mr-2" />
              {isSearching ? 'Searching...' : 'Search LinkedIn'}
            </Button>
            <p className="text-xs text-slate-400">
              {isSearching
                ? 'Fetching LinkedIn profiles...'
                : 'Click profiles to view LinkedIn pages'}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default NewConnectionsTab;
