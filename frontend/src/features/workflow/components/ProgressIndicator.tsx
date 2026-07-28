/**
 * Progress Indicator Component for Message Generation Workflow
 * Task 9: Comprehensive error handling and user feedback
 */

import React from 'react';
import { Progress } from '@/shared/components/ui/progress';
import { Button } from '@/shared/components/ui/button';
import { Card, CardContent } from '@/shared/components/ui/card';
import { Loader2, Square, Clock, CheckCircle, AlertCircle } from 'lucide-react';
import type { ProgressState, LoadingState } from '@/types';

interface ProgressIndicatorProps {
  progressState: ProgressState;
  loadingState: LoadingState;
  onCancel?: () => void;
  className?: string;
}

const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({
  progressState,
  loadingState,
  onCancel,
  className = '',
}) => {
  const getProgressPercentage = () => {
    if (progressState.total === 0) return 0;
    return Math.round((progressState.current / progressState.total) * 100);
  };

  const getEstimatedTimeString = () => {
    if (!progressState.estimatedTimeRemaining) return null;

    const minutes = Math.floor(progressState.estimatedTimeRemaining / 60);
    const seconds = progressState.estimatedTimeRemaining % 60;

    if (minutes > 0) {
      return `${minutes}m ${seconds}s remaining`;
    } else {
      return `${seconds}s remaining`;
    }
  };

  const getPhaseIcon = () => {
    switch (progressState.phase) {
      case 'preparing':
        return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
      case 'generating':
        return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
      case 'waiting_approval':
        return <Clock className="h-4 w-4 text-yellow-500" />;
      case 'completed':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'error':
        return <AlertCircle className="h-4 w-4 text-red-500" />;
      default:
        return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
    }
  };

  const getPhaseDescription = () => {
    switch (progressState.phase) {
      case 'preparing':
        return 'Preparing message generation...';
      case 'generating':
        return progressState.currentConnectionName
          ? `Generating message for ${progressState.currentConnectionName}...`
          : 'Generating messages...';
      case 'waiting_approval':
        return 'Waiting for your approval...';
      case 'completed':
        return 'Message generation completed!';
      case 'error':
        return 'An error occurred during generation';
      default:
        return 'Processing...';
    }
  };

  if (!loadingState.isLoading && progressState.phase === 'preparing') {
    return null;
  }

  return (
    <Card className={`bg-slate-800 border-slate-700 ${className}`}>
      <CardContent className="p-4">
        {/* Message generation runs for minutes. Without a live region a screen
            reader user gets no feedback for the whole run — the phase text and
            the counters change silently. polite, not assertive: this is status,
            not an alert, and it must not interrupt whatever is being read. */}
        <div className="space-y-3" aria-live="polite" aria-busy={loadingState.isLoading}>
          {/* Phase indicator */}
          <div className="flex items-center space-x-2">
            {getPhaseIcon()}
            <span className="text-sm font-medium text-white">{getPhaseDescription()}</span>
          </div>

          {/* Progress bar */}
          {progressState.total > 0 && (
            <div className="space-y-2">
              <Progress value={getProgressPercentage()} className="h-2 bg-slate-700" />
              <div className="flex justify-between text-xs text-slate-400">
                <span>
                  {progressState.current} of {progressState.total} connections
                </span>
                <span>{getProgressPercentage()}%</span>
              </div>
            </div>
          )}

          {/* Loading message */}
          {loadingState.message && (
            <div className="text-sm text-slate-300">{loadingState.message}</div>
          )}

          {/* Estimated time */}
          {getEstimatedTimeString() && (
            <div className="text-xs text-slate-400 flex items-center space-x-1">
              <Clock className="h-3 w-3" />
              <span>{getEstimatedTimeString()}</span>
            </div>
          )}

          {/* Cancel button */}
          {loadingState.canCancel && onCancel && (
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={onCancel}
                className="bg-red-600/20 border-red-400/50 text-red-300 hover:bg-red-600/30"
              >
                <Square className="h-3 w-3 mr-1" />
                Stop Generation
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default ProgressIndicator;
