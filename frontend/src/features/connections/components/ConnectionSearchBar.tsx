/**
 * ConnectionSearchBar Component
 *
 * Search input for finding connections with clear button and loading indicator.
 */
import React, { useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, X, Loader2 } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

interface ConnectionSearchBarProps {
  /** Current search value */
  value: string;
  /** Callback when value changes */
  onChange: (value: string) => void;
  /** Callback when clear button is clicked */
  onClear: () => void;
  /** Whether a search is in progress */
  isLoading: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Search input component for the Connections tab
 */
export const ConnectionSearchBar: React.FC<ConnectionSearchBarProps> = ({
  value,
  onChange,
  onClear,
  isLoading,
  placeholder = 'Search your connections...',
  className,
}) => {
  /**
   * Handle input change
   */
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(e.target.value);
    },
    [onChange]
  );

  /**
   * Handle keyboard events
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape' && value) {
        e.preventDefault();
        onClear();
      }
    },
    [value, onClear]
  );

  const showClearButton = value.length > 0 && !isLoading;
  const showLoadingSpinner = isLoading && value.length > 0;

  return (
    <div className={cn('relative', className)}>
      {/* Search Icon */}
      <Search
        className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none"
        aria-hidden="true"
      />

      {/* Search Input */}
      <Input
        type="text"
        data-testid="search-input"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label="Search connections"
        aria-busy={isLoading}
        className={cn(
          'pl-10 pr-10',
          'bg-white/5 border-white/20 text-white placeholder-slate-400',
          'focus:border-blue-500 focus:ring-1 focus:ring-blue-500',
          'transition-colors'
        )}
      />

      {/* Clear Button / Loading Spinner */}
      <div className="absolute right-2 top-1/2 transform -translate-y-1/2">
        {showLoadingSpinner && (
          <div
            role="status"
            aria-label="Searching..."
            className="flex items-center justify-center w-6 h-6"
          >
            <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
            <span className="sr-only">Searching...</span>
          </div>
        )}

        {showClearButton && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClear}
            aria-label="Clear search"
            className="h-6 w-6 p-0 hover:bg-white/10 rounded-full"
          >
            <X className="h-4 w-4 text-slate-400" />
          </Button>
        )}
      </div>
    </div>
  );
};
