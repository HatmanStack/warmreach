import React, { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { User, Building, MapPin, Tag, X, Loader2, CheckCircle, UserPlus } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { lambdaApiService as dbConnector } from '@/services/lambdaApiService';
import { commandService } from '@/shared/services/commandService';
import { transformErrorForUser, getToastVariant, ERROR_MESSAGES } from '@/utils/errorHandling';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('NewConnectionCard');
import type { NewConnectionCardProps } from '@/types';
import { ConversionLikelihoodBadge } from './ConversionLikelihoodBadge';

/**
 * NewConnectionCard Component
 *
 * Simplified card component for displaying 'possible' status connections.
 * Excludes message-related information and includes conversion likelihood
 * percentage display with remove functionality.
 *
 * @param props - The component props
 * @param props.connection - Connection data to display (must have status 'possible')
 * @param props.onRemove - Callback when remove button is clicked
 * @param props.onSelect - Callback when card is selected
 * @param props.className - Additional CSS classes
 *
 * @returns JSX element representing the new connection card
 */
const NewConnectionCard: React.FC<NewConnectionCardProps> = ({
  connection,
  onRemove,
  onSelect,
  onTagClick,
  activeTags = [],
}) => {
  const [isRemoving, setIsRemoving] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isTagsOpen, setIsTagsOpen] = useState(false);
  // Keep the tags "… more" button visible by limiting tags based on character budget
  const [tagCharBudget, setTagCharBudget] = useState<number>(48);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [skipRemoveConfirm, setSkipRemoveConfirm] = useState(false);
  const { toast } = useToast();

  // Preference storage key
  const REMOVE_CONFIRM_PREF_KEY = 'hideRemoveConfirm';

  useEffect(() => {
    try {
      const pref = localStorage.getItem(REMOVE_CONFIRM_PREF_KEY) === 'true';
      setDontShowAgain(pref);
      setSkipRemoveConfirm(pref);
    } catch {
      // ignore storage errors
    }
  }, [connection?.id]);

  // Build a LinkedIn profile URL from either a full URL, profile id, or fallback to id
  const buildLinkedInProfileUrl = (): string | null => {
    const raw = connection.linkedin_url || connection.id;
    if (!raw) return null;
    const hasProtocol = /^https?:\/\//i.test(raw);
    return hasProtocol ? raw : `https://www.linkedin.com/in/${raw}`;
  };

  /**
   * Handles tag click events, preventing bubbling and delegating to parent
   */
  const handleTagClick = (tag: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (onTagClick) onTagClick(tag);
  };

  // Navigate to LinkedIn profile on card click (except when removing or clicking buttons)
  const handleCardClick = (e: React.MouseEvent) => {
    if (isRemoving || isConnecting) return;

    const url = buildLinkedInProfileUrl();
    // Only navigate if the original event target wasn't a button inside our controls area
    const target = e.target as HTMLElement | null;
    if (target && target.closest('button')) return;

    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    } else if (onSelect) {
      onSelect(connection);
    }
  };

  /**
   * Handles remove button click events, preventing event bubbling and opening confirmation dialog
   *
   * @param e - The mouse event
   */
  const handleRemoveClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (skipRemoveConfirm) {
      // Directly remove without showing modal
      void handleConfirmRemove();
    } else {
      setIsDialogOpen(true);
    }
  };

  /**
   * Handles the confirmed removal of a connection by updating its status to 'processed'
   * Shows loading states, success feedback, and error handling with recovery options
   */
  const handleConfirmRemove = async () => {
    setIsRemoving(true);
    setIsDialogOpen(false);

    try {
      // Determine profile identifier to pass to edge API (linkedin URL or fallback to id)
      const profileId = connection.linkedin_url || connection.id;

      // Update status from 'possible' to 'processed' via edge API
      await dbConnector.updateConnectionStatus(connection.id, 'processed', { profileId });

      // Show success feedback with animation
      toast({
        title: 'Connection Removed',
        description: (
          <div className="flex items-center space-x-2">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <span>
              {connection.first_name} {connection.last_name} has been removed from new connections.
            </span>
          </div>
        ),
        variant: 'default',
      });

      // Notify parent component to update status/remove from UI
      if (onRemove) {
        onRemove(connection.id, 'processed');
      }
    } catch (error) {
      logger.error('Error removing connection', { error });

      // Transform error for user-friendly display
      const errorInfo = transformErrorForUser(error, ERROR_MESSAGES.REMOVE_CONNECTION, [
        {
          label: 'Try Again',
          action: () => handleConfirmRemove(),
          primary: true,
        },
        {
          label: 'Refresh Page',
          action: () => window.location.reload(),
        },
      ]);

      // Show error feedback with recovery options
      toast({
        title: 'Remove Failed',
        description: errorInfo.userMessage,
        variant: getToastVariant(errorInfo.severity),
      });
    } finally {
      setIsRemoving(false);
    }
  };

  const handleCancelRemove = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setIsDialogOpen(false);
  };

  const handleDontShowAgainChange = (checked: boolean | 'indeterminate') => {
    const value = checked === true;
    setDontShowAgain(value);
    setSkipRemoveConfirm(value);
    try {
      localStorage.setItem(REMOVE_CONFIRM_PREF_KEY, String(value));
    } catch {
      // ignore storage errors
    }
  };

  // Adjust tag character budget responsively (match ConnectionCard behavior)
  useEffect(() => {
    const calculateBudget = () => {
      const width = window.innerWidth;
      let budget = 48;
      if (width < 380) budget = 18;
      else if (width < 640) budget = 26;
      else if (width < 1024) budget = 34;
      setTagCharBudget(budget);
    };
    calculateBudget();
    window.addEventListener('resize', calculateBudget);
    return () => window.removeEventListener('resize', calculateBudget);
  }, []);

  const getVisibleTagsByCharacterBudget = (allTags: string[]) => {
    if (!allTags || allTags.length === 0) {
      return { visible: [] as string[], hasMore: false };
    }
    const reservedForMore = 6; // approx chars for "+ more"
    const effectiveBudget = Math.max(0, tagCharBudget - reservedForMore);
    let used = 0;
    const visible: string[] = [];
    for (let i = 0; i < allTags.length; i++) {
      const tag = allTags[i];
      const cost = tag.length + 2; // crude width for padding/gap
      if (used + cost > effectiveBudget) break;
      visible.push(tag);
      used += cost;
    }
    return { visible, hasMore: visible.length < allTags.length };
  };

  /**
   * Handles connect button click events, preventing event bubbling and updating connection status
   *
   * @param e - The mouse event
   */
  const handleConnectClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // Skip if already pending/outgoing
    if (connection.status === 'outgoing') {
      toast({
        title: 'Connection Request Sent',
        description: (
          <div className="flex items-center space-x-2">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <span>
              Connection request sent to {connection.first_name} {connection.last_name}.
            </span>
          </div>
        ),
        variant: 'default',
      });
      if (onRemove) onRemove(connection.id, 'outgoing');
      return;
    }
    setIsConnecting(true);

    try {
      // Dispatch command to Electron agent to send the LinkedIn connection request
      const profileId = connection.linkedin_url || connection.id;
      await commandService.dispatch('linkedin:add-connection', {
        profileId,
        profileName: `${connection.first_name} ${connection.last_name}`,
      });

      // Update status to 'outgoing' in DB for consistency
      try {
        await dbConnector.updateConnectionStatus(connection.id, 'outgoing', { profileId });
      } catch {
        // Ignore DB update failures
      }

      // Regardless of response status (sent/pending/outgoing), show success and remove from UI
      toast({
        title: 'Connection Request Sent',
        description: (
          <div className="flex items-center space-x-2">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <span>
              Connection request sent to {connection.first_name} {connection.last_name}.
            </span>
          </div>
        ),
        variant: 'default',
      });
      if (onRemove) onRemove(connection.id, 'outgoing');
    } catch (error) {
      logger.error('Error connecting', { error });

      // Transform error for user-friendly display
      const errorInfo = transformErrorForUser(error, ERROR_MESSAGES.UPDATE_CONNECTION, [
        {
          label: 'Try Again',
          action: () => handleConnectClick(e),
          primary: true,
        },
        {
          label: 'Refresh Page',
          action: () => window.location.reload(),
        },
      ]);

      // Show error feedback with recovery options
      toast({
        title: 'Connect Failed',
        description: errorInfo.userMessage,
        variant: getToastVariant(errorInfo.severity),
      });
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <div
      className={`p-4 my-3 rounded-lg border cursor-pointer transition-all duration-200 relative ${
        isRemoving
          ? 'bg-gray-600/20 border-gray-500 opacity-50'
          : 'bg-white/5 border-white/10 hover:bg-white/10'
      }`}
      onClick={handleCardClick}
    >
      <div className="flex items-start space-x-4">
        {/* Profile Picture Space */}
        <div className="w-12 h-12 bg-gradient-to-r from-blue-500 to-purple-500 rounded-full flex items-center justify-center text-white font-semibold flex-shrink-0">
          {connection.first_name[0]}
          {connection.last_name[0]}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1">
            {/* Name of Connection */}
            <h3 className="text-white font-semibold truncate">
              {connection.first_name} {connection.last_name}
            </h3>

            <div className="flex flex-col items-end space-y-1 flex-shrink-0">
              <div className="flex items-center space-x-2">
                {/* Demo Data Badge */}
                {connection.isFakeData && (
                  <div className="bg-yellow-600/90 text-yellow-100 text-xs px-2 py-1 rounded-full font-medium shadow-lg">
                    Demo Data
                  </div>
                )}

                {/* Connect Button */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 bg-gradient-to-r from-green-600 to-teal-600 hover:from-green-700 hover:to-teal-700 text-white"
                  onClick={handleConnectClick}
                  disabled={isConnecting || isRemoving}
                  title="Send connection request"
                >
                  {isConnecting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <UserPlus className="h-4 w-4" />
                  )}
                </Button>

                {/* Remove Button - controlled modal open to avoid unwanted popup when preference is set */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-red-400 hover:text-red-300 hover:bg-red-500/20"
                  onClick={handleRemoveClick}
                  disabled={isRemoving}
                >
                  {isRemoving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <X className="h-4 w-4" />
                  )}
                </Button>
                <AlertDialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                  <AlertDialogContent onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove Connection</AlertDialogTitle>
                      <AlertDialogDescription>
                        Are you sure you want to remove {connection.first_name}{' '}
                        {connection.last_name} from your new connections? This action will mark them
                        as processed and they won't appear in this list again.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="flex items-center space-x-2 mt-2">
                      <Checkbox
                        id="dont-show-remove"
                        checked={dontShowAgain}
                        onCheckedChange={handleDontShowAgainChange}
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      />
                      <label
                        htmlFor="dont-show-remove"
                        className="text-sm font-medium text-slate-900 dark:text-slate-100"
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      >
                        Don’t show this message again when removing a connection
                      </label>
                    </div>
                    <AlertDialogFooter>
                      <AlertDialogCancel onClick={(e: React.MouseEvent) => handleCancelRemove(e)}>
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          void handleConfirmRemove();
                        }}
                        className="bg-red-600 hover:bg-red-700"
                      >
                        Remove
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>

              {/* Conversion Likelihood Badge */}
              {connection.conversion_likelihood && (
                <ConversionLikelihoodBadge likelihood={connection.conversion_likelihood} />
              )}
            </div>
          </div>

          {/* Job Title and Company on Same Line */}
          <div className="flex items-center text-slate-300 text-sm mb-2 flex-wrap">
            <User className="h-3 w-3 mr-1 flex-shrink-0" />
            <span className="truncate">{connection.position}</span>
            {connection.company && (
              <>
                <Building className="h-3 w-3 ml-3 mr-1 flex-shrink-0" />
                <span className="truncate">{connection.company}</span>
              </>
            )}
          </div>

          {/* Location */}
          {connection.location && (
            <div className="flex items-center text-slate-400 text-sm mb-2">
              <MapPin className="h-3 w-3 mr-1 flex-shrink-0" />
              <span className="truncate">{connection.location}</span>
            </div>
          )}

          {/* Headline */}
          {connection.headline && (
            <p className="text-slate-400 text-sm mb-3 line-clamp-2">{connection.headline}</p>
          )}

          {/* Tags - Single line, visible tag budget + "+N more" like ConnectionCard */}
          {(connection.tags?.length || connection.common_interests?.length) &&
            (() => {
              const allTags = (connection.tags || connection.common_interests || []) as string[];
              const { visible, hasMore } = getVisibleTagsByCharacterBudget(allTags);
              return (
                <div className="mb-2">
                  <div className="flex items-center overflow-hidden flex-nowrap gap-2 max-w-full whitespace-nowrap leading-7 min-h-[28px] py-0.5">
                    <Tag className="h-3 w-3 text-slate-400 mr-1 flex-shrink-0" />
                    {visible.map((tag: string, index: number) => (
                      <Badge
                        key={index}
                        variant="outline"
                        className={`cursor-pointer text-xs transition-all duration-200 hover:scale-105 flex-shrink-0 ${
                          activeTags.includes(tag)
                            ? 'bg-blue-600 text-white border-blue-500 shadow-lg'
                            : 'border-blue-400/30 text-blue-300 hover:bg-blue-600/20 hover:border-blue-400'
                        }`}
                        onClick={(e: React.MouseEvent) => handleTagClick(tag, e)}
                      >
                        {tag}
                      </Badge>
                    ))}
                    {hasMore && (
                      <Badge
                        variant="outline"
                        className="cursor-pointer text-xs border-slate-400/30 text-slate-400 flex-shrink-0 ml-1 transition-all duration-200 hover:scale-[1.2] hover:bg-slate-500/20 hover:border-slate-400/50 hover:text-slate-200"
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          setIsTagsOpen(true);
                        }}
                      >
                        +{allTags.length - visible.length} more
                      </Badge>
                    )}
                  </div>
                </div>
              );
            })()}

          {/* Date Added */}
          {connection.date_added && (
            <p className="text-slate-500 text-xs mt-2">
              Added: {new Date(connection.date_added).toLocaleDateString()}
            </p>
          )}
        </div>
      </div>

      {/* Tags Modal */}
      <Dialog open={isTagsOpen} onOpenChange={setIsTagsOpen}>
        <DialogContent
          className="text-slate-100 bg-slate-900 border border-slate-700 shadow-2xl"
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle className="text-white">Tags</DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap gap-2">
            {(connection.tags || connection.common_interests || []).map(
              (tag: string, index: number) => (
                <Badge
                  key={`all-${index}`}
                  variant="outline"
                  className={`cursor-pointer text-xs transition-all duration-200 hover:scale-105 ${
                    activeTags.includes(tag)
                      ? 'bg-blue-600 text-white border-blue-500 shadow-lg'
                      : 'border-blue-400/30 text-blue-300 hover:bg-blue-600/20 hover:border-blue-400'
                  }`}
                  onClick={(e: React.MouseEvent) => handleTagClick(tag, e)}
                >
                  {tag}
                </Badge>
              )
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default NewConnectionCard;
