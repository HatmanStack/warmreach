import React, { useState, useEffect, useRef } from 'react';
import { Button } from '@/shared/components/ui/button';
import { ScrollArea } from '@/shared/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import {
  Send,
  MessageSquare,
  Loader2,
  AlertCircle,
  Sparkles,
  Check,
  SkipForward,
  ScanEye,
} from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { useToast } from '@/shared/hooks';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('MessageModal');
import {
  transformErrorForUser,
  getToastVariant,
  ERROR_MESSAGES,
} from '@/shared/utils/errorHandling';
import { NoMessagesState } from '@/shared/components/ui/empty-state';
import LoadingOverlay from '@/shared/components/ui/loading-overlay';
import type { MessageModalProps } from '@/types';
import { useTier } from '@/features/tier';
import { useToneAnalysis } from '@/features/connections/hooks/useToneAnalysis';
import { ToneAnalysisBadge } from '@/features/connections/components/ToneAnalysisBadge';

export const MessageModal: React.FC<MessageModalProps> = ({
  isOpen,
  connection,
  onClose,
  onSendMessage,
  isLoadingMessages = false,
  messagesError = null,
  onRetryLoadMessages,
  prePopulatedMessage,
  isGeneratedContent = false,
  showGenerationControls = false,
  onApproveAndNext,
  onSkipConnection,
}) => {
  const [messageInput, setMessageInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const { isFeatureEnabled } = useTier();
  const {
    result: toneResult,
    isAnalyzing,
    analyzeTone,
    clearResult: clearToneResult,
  } = useToneAnalysis();

  // Handle pre-populated message content
  useEffect(() => {
    logger.info('MessageModal useEffect', {
      hasPrePopulatedMessage: Boolean(prePopulatedMessage),
      prePopulatedMessageLength: prePopulatedMessage?.length ?? 0,
      isOpen,
      connectionId: connection?.id,
    });
    if (prePopulatedMessage && isOpen) {
      setMessageInput(prePopulatedMessage);
    } else if (!prePopulatedMessage && isOpen) {
      setMessageInput('');
    }
  }, [prePopulatedMessage, isOpen, connection?.id]);

  const formatTimestamp = (timestamp: string): string => {
    try {
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) return 'Unknown time';
      return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return 'Unknown time';
    }
  };

  // Scroll to bottom when messages change
  useEffect(() => {
    if (scrollAreaRef.current) {
      const scrollElement = scrollAreaRef.current.querySelector(
        '[data-radix-scroll-area-viewport]'
      );
      if (scrollElement) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    }
  }, [connection.message_history]);

  // Handle generation workflow shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isOpen) return;
      if (showGenerationControls) {
        if (event.key === 'Enter' && !event.shiftKey && event.ctrlKey) {
          event.preventDefault();
          if (onApproveAndNext) onApproveAndNext();
        } else if (event.key === 's' && event.ctrlKey) {
          event.preventDefault();
          if (onSkipConnection) onSkipConnection();
        }
      }
    };
    if (isOpen) document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, showGenerationControls, onApproveAndNext, onSkipConnection]);

  const handleSendMessage = async () => {
    const trimmedMessage = messageInput.trim();
    if (!trimmedMessage) {
      toast({
        title: 'Empty Message',
        description: 'Please enter a message before sending.',
        variant: 'default',
      });
      return;
    }
    if (trimmedMessage.length > 1000) {
      toast({
        title: 'Message Too Long',
        description: 'Messages must be 1000 characters or less.',
        variant: 'destructive',
      });
      return;
    }
    if (!onSendMessage) {
      toast({
        title: 'Feature Not Available',
        description: 'Message sending will be available in a future update.',
        variant: 'default',
      });
      return;
    }
    setIsSending(true);
    try {
      await onSendMessage(trimmedMessage);
      setMessageInput('');
      toast({
        title: 'Message Sent',
        description: 'Your message has been sent successfully.',
        variant: 'default',
      });
    } catch (error) {
      logger.error('Error sending message', { error });
      const errorInfo = transformErrorForUser(error, ERROR_MESSAGES.SEND_MESSAGE, [
        { label: 'Try Again', action: () => handleSendMessage(), primary: true },
      ]);
      toast({
        title: 'Send Failed',
        description: errorInfo.userMessage,
        variant: getToastVariant(errorInfo.severity),
      });
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (showGenerationControls && onApproveAndNext) {
        onApproveAndNext();
      } else {
        handleSendMessage();
      }
    }
  };

  const messages = connection.message_history || [];
  const connectionName =
    `${connection.first_name} ${connection.last_name}`.trim() || 'Unknown Contact';

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          if (showGenerationControls && onSkipConnection) {
            onSkipConnection();
          } else {
            onClose();
          }
        }
      }}
    >
      <DialogContent
        data-testid="message-modal"
        className="sm:max-w-[700px] max-h-[85vh] flex flex-col bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 border-white/10"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-white">
            <MessageSquare className="h-5 w-5 text-blue-400" />
            {connectionName}
            {isGeneratedContent && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/20 text-blue-300 border border-blue-500/30">
                <Sparkles className="h-3 w-3 mr-1" />
                AI Generated
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            {connection.position && connection.company
              ? `${connection.position} at ${connection.company}`
              : connection.position || connection.company || 'LinkedIn Connection'}
          </DialogDescription>
        </DialogHeader>

        {/* Message History */}
        <div className="flex-1 min-h-0">
          <LoadingOverlay
            isLoading={isLoadingMessages}
            message="Loading message history..."
            className="h-[500px] w-full border border-white/10 rounded-md"
          >
            <ScrollArea
              ref={scrollAreaRef}
              className="h-[500px] w-full border border-white/10 rounded-md p-4"
            >
              {messagesError ? (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <AlertCircle className="h-12 w-12 mb-4 text-red-400 opacity-50" />
                  <p className="text-lg font-medium mb-2 text-red-300">Failed to Load Messages</p>
                  <p className="text-sm text-red-400 mb-4">{messagesError}</p>
                  {onRetryLoadMessages && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onRetryLoadMessages}
                      className="border-red-500/30 text-red-300 hover:bg-red-500/10"
                    >
                      Try Again
                    </Button>
                  )}
                </div>
              ) : messages.length === 0 ? (
                <NoMessagesState connectionName={connection.first_name} className="h-full" />
              ) : (
                <div className="space-y-4">
                  {messages.map((message, index) => (
                    <div
                      key={message.id || `msg-${index}`}
                      className={cn(
                        'flex flex-col max-w-[80%]',
                        message.sender === 'user' ? 'ml-auto items-end' : 'mr-auto items-start'
                      )}
                    >
                      <div
                        className={cn(
                          'rounded-lg px-4 py-2 text-sm',
                          message.sender === 'user'
                            ? 'bg-blue-600 text-white'
                            : 'bg-white/10 text-slate-300'
                        )}
                      >
                        <p className="whitespace-pre-wrap break-words">{message.content}</p>
                      </div>
                      <span className="text-xs text-slate-500 mt-1">
                        {formatTimestamp(message.timestamp)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </LoadingOverlay>
        </div>

        {/* Tone Analysis Result */}
        {toneResult && <ToneAnalysisBadge result={toneResult} onClose={clearToneResult} />}

        {/* Message Input */}
        <div className="flex flex-col gap-1 pt-2 min-h-[120px]">
          <div className="flex w-full gap-2 flex-1">
            <textarea
              placeholder="Type your message..."
              value={messageInput}
              onChange={(e) => {
                setMessageInput(e.target.value);
                if (toneResult) clearToneResult();
              }}
              onKeyDown={handleKeyDown}
              disabled={isSending}
              maxLength={1000}
              className="flex-1 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 resize-none"
            />
            <div className="flex flex-col gap-2">
              {showGenerationControls ? (
                <>
                  <Button
                    onClick={() => onApproveAndNext?.()}
                    size="sm"
                    className="shrink-0 bg-green-600 hover:bg-green-700 text-white"
                    disabled={isSending}
                  >
                    <Check className="h-4 w-4 mr-1" />
                    Approve
                  </Button>
                  <Button
                    onClick={() => onSkipConnection?.()}
                    size="sm"
                    className="shrink-0 bg-slate-600 hover:bg-slate-700 text-white"
                    disabled={isSending}
                  >
                    <SkipForward className="h-4 w-4 mr-1" />
                    Skip
                  </Button>
                </>
              ) : (
                <>
                  {isFeatureEnabled('tone_analysis') && (
                    <Button
                      onClick={() =>
                        analyzeTone(
                          messageInput,
                          connection.first_name,
                          connection.position,
                          connection.status
                        )
                      }
                      disabled={!messageInput.trim() || isAnalyzing}
                      size="icon"
                      className="shrink-0 bg-purple-600 hover:bg-purple-700"
                      aria-label="Check tone"
                      data-testid="check-tone-button"
                    >
                      {isAnalyzing ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ScanEye className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                  <Button
                    onClick={handleSendMessage}
                    disabled={isSending || !messageInput.trim()}
                    size="icon"
                    className="shrink-0 bg-blue-600 hover:bg-blue-700"
                    aria-label="Send message"
                  >
                    {isSending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                </>
              )}
            </div>
          </div>
          <div className="flex justify-end w-full text-xs text-slate-500">
            <span>{messageInput.length}/1000</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
