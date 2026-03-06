import React from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Users, Clock, Send, UserCheck, Filter } from 'lucide-react';
import type { StatusValue, StatusPickerProps } from '@/types';

/**
 * Status mapping configuration interface
 */
interface StatusMapping {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

/**
 * StatusPicker Component
 *
 * A filter component for connection management that allows users to filter connections
 * by status type. Maps database status values to user-friendly display labels and
 * shows connection counts for each status.
 *
 * Features:
 * - Select dropdown interface for status selection
 * - Connection count badges for each status
 * - "All Statuses" option to show all connections
 * - Consistent styling with Dashboard components
 *
 * Status Mapping:
 * - all → "All Statuses" (shows total count)
 * - incoming → "Pending" (shows incoming count)
 * - outgoing → "Sent" (shows outgoing count)
 * - ally → "Connections" (shows ally count)
 */

/**
 * Status mapping from database values to display labels
 * Maps StatusValue keys to their display configuration including label and icon
 */
const STATUS_MAPPING: Record<StatusValue, StatusMapping> = {
  all: { label: 'All Statuses', icon: Filter },
  incoming: { label: 'Pending', icon: Clock },
  outgoing: { label: 'Sent', icon: Send },
  ally: { label: 'Connections', icon: UserCheck },
} as const;

/**
 * StatusPicker Component
 *
 * @param props - The component props
 * @param props.selectedStatus - Currently selected status filter
 * @param props.onStatusChange - Callback when status selection changes
 * @param props.connectionCounts - Connection counts for each status type
 * @param props.className - Additional CSS classes
 *
 * @returns JSX element representing the status picker
 */
const StatusPicker: React.FC<StatusPickerProps> = ({
  selectedStatus,
  onStatusChange,
  connectionCounts,
  className = '',
}) => {
  /**
   * Gets the connection count for a specific status value
   * Only counts incoming, outgoing, and ally statuses (excludes possible)
   *
   * @param status - The status value to get count for
   * @returns The number of connections for the given status
   */
  const getStatusCount = (status: StatusValue): number => {
    switch (status) {
      case 'all':
        // Only count incoming, outgoing, and ally (exclude possible status)
        return connectionCounts.incoming + connectionCounts.outgoing + connectionCounts.ally;
      case 'incoming':
        return connectionCounts.incoming;
      case 'outgoing':
        return connectionCounts.outgoing;
      case 'ally':
        return connectionCounts.ally;
      default:
        return 0;
    }
  };

  /**
   * Renders the display content for the currently selected status
   *
   * @returns JSX element with icon, label, and count badge
   */
  const getSelectedStatusDisplay = () => {
    const config = STATUS_MAPPING[selectedStatus];
    const Icon = config.icon;
    const count = getStatusCount(selectedStatus);

    return (
      <div className="flex items-center space-x-2">
        <Icon className="h-4 w-4" />
        <span>{config.label}</span>
        <Badge
          variant="outline"
          className="ml-2 text-xs bg-blue-600/20 border-blue-400/50 text-blue-300"
        >
          {count}
        </Badge>
      </div>
    );
  };

  /**
   * Renders a select item for a specific status with icon, label, and count badge
   *
   * @param status - The status value to render
   * @returns JSX element representing the select item
   */
  const renderSelectItem = (status: StatusValue) => {
    const config = STATUS_MAPPING[status];
    const Icon = config.icon;
    const count = getStatusCount(status);

    return (
      <SelectItem key={status} value={status}>
        <div className="flex items-center space-x-2 w-full">
          <Icon className="h-4 w-4" />
          <span className="flex-1">{config.label}</span>
          <Badge
            variant="outline"
            className="ml-2 text-xs bg-white/5 border-white/20 text-slate-400"
          >
            {count}
          </Badge>
        </div>
      </SelectItem>
    );
  };

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="flex items-center space-x-2 mb-4">
        <Users className="h-5 w-5 text-blue-400" />
        <h3 className="text-lg font-semibold text-white">Filter Connections</h3>
      </div>

      <div className="space-y-2">
        <Label htmlFor="status-select" className="text-sm font-medium text-slate-300">
          Connection Status
        </Label>
        <Select
          value={selectedStatus}
          onValueChange={(value) => onStatusChange(value as StatusValue)}
        >
          <SelectTrigger
            id="status-select"
            data-testid="status-filter"
            className="w-full bg-white/5 border-white/20 text-white hover:bg-white/10 focus:border-blue-400"
          >
            <SelectValue>{getSelectedStatusDisplay()}</SelectValue>
          </SelectTrigger>
          <SelectContent className="bg-slate-800 border-white/20">
            {(Object.keys(STATUS_MAPPING) as StatusValue[]).map(renderSelectItem)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
};

export default StatusPicker;
