import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useToast } from '@/shared/hooks';
import { useErrorHandler } from '@/shared/hooks';
import { useProgressTracker } from '@/features/workflow';
import { messageGenerationService } from '@/features/messages';
import { commandService } from '@/shared/services/commandService';
import { connectionDataContextService } from '@/features/connections';
import { useWorkflowStateMachine } from './useWorkflowStateMachine';
import { useMessageModal } from './useMessageModal';
import { useMessageHistory } from './useMessageHistory';
import type { Connection, UserProfile } from '@/types';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('useMessageGeneration');

interface UseMessageGenerationOptions {
  connections: Connection[];
  selectedConnections: string[];
  conversationTopic: string;
  userProfile: UserProfile | null;
}

export function useMessageGeneration({
  connections,
  selectedConnections,
  conversationTopic,
  userProfile,
}: UseMessageGenerationOptions) {
  const { toast } = useToast();
  const errorHandler = useErrorHandler();
  const progressTracker = useProgressTracker();

  // Composed hooks
  const workflow = useWorkflowStateMachine();
  const modal = useMessageModal();
  const history = useMessageHistory();

  // Generated messages map (local state)
  const [generatedMessages, setGeneratedMessages] = useState<Map<string, string>>(new Map());

  // Ref to track if we should continue the workflow after modal actions
  const continueWorkflowRef = useRef<(() => void) | null>(null);

  // Ref to track latest history methods to avoid stale closures
  const historyRef = useRef(history);
  historyRef.current = history;

  // Track the post-completion reset timeout so it can be cleared on unmount;
  // otherwise it fires after the component is gone and updates unmounted state.
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Same for the in-flight delivery-confirmation wait (see handleSendMessage):
  // if the hook unmounts mid-wait, this 45s timer must not fire against a stale
  // closure.
  const deliveryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current) {
        clearTimeout(resetTimeoutRef.current);
        resetTimeoutRef.current = null;
      }
      if (deliveryTimeoutRef.current) {
        clearTimeout(deliveryTimeoutRef.current);
        deliveryTimeoutRef.current = null;
      }
    };
  }, []);

  // Fetch message history when modal connection changes
  useEffect(() => {
    const connection = modal.selectedConnection;
    if (connection) {
      historyRef.current.fetchHistory(connection.id);
    } else {
      historyRef.current.clearHistory();
    }
  }, [modal.selectedConnection]);

  // Message generation for a single connection
  // Note: message_history is intentionally empty during batch generation to avoid
  // using stale history from a different connection. History is only used when
  // viewing/editing a single connection's messages via the modal.
  const generateMessageForConnection = useCallback(
    async (connection: Connection): Promise<string> => {
      const cleanedTopic = connectionDataContextService.prepareConversationTopic(conversationTopic);
      const connectionWithHistory = { ...connection, message_history: [] } as Connection;
      const context = connectionDataContextService.prepareMessageGenerationContext(
        connectionWithHistory,
        cleanedTopic,
        userProfile || undefined,
        { includeMessageHistory: false }
      );
      const request = connectionDataContextService.createMessageGenerationRequest(context);
      return messageGenerationService.generateMessage(request);
    },
    [conversationTopic, userProfile]
  );

  // CALLBACK-BASED approval handlers (no polling!)
  const handleApproveAndNext = useCallback(() => {
    modal.closeModal();
    workflow.approveAndContinue();
    // Trigger continuation
    if (continueWorkflowRef.current) {
      continueWorkflowRef.current();
    }
  }, [modal, workflow]);

  const handleSkipConnection = useCallback(() => {
    modal.closeModal();
    workflow.approveAndContinue();
    // Trigger continuation
    if (continueWorkflowRef.current) {
      continueWorkflowRef.current();
    }
  }, [modal, workflow]);

  const handleStopGeneration = useCallback(() => {
    workflow.stop();
    modal.closeModal();
    progressTracker.resetProgress();
    workflow.reset();
    errorHandler.showInfoFeedback('Message generation has been stopped.', 'Generation Stopped');
  }, [workflow, modal, progressTracker, errorHandler]);

  const handleMessageClick = useCallback(
    async (connection: Connection) => {
      modal.openModal(connection);
      try {
        await history.fetchHistory(connection.id);
      } catch (err: unknown) {
        logger.error('Error fetching message history', { error: err });
        toast({
          title: 'Failed to Load Messages',
          description: 'Could not load message history.',
          variant: 'destructive',
        });
      }
    },
    [modal, history, toast]
  );

  const handleCloseMessageModal = useCallback(() => {
    modal.closeModal();
    history.clearHistory();
  }, [modal, history]);

  const handleSendMessage = useCallback(
    async (message: string): Promise<void> => {
      const connection = modal.selectedConnection;
      if (!connection) return;

      const recipientProfileId = connection.linkedin_url || connection.id;
      const recipientName = `${connection.first_name} ${connection.last_name}`.trim();
      logger.info('Sending message', { connectionId: connection.id });

      let commandId: string;
      try {
        // Dispatch the real send to the desktop agent (field names must match
        // the client's sendMessageDirect payload exactly).
        ({ commandId } = await commandService.dispatch('linkedin:send-message', {
          recipientProfileId,
          messageContent: message,
          recipientName,
        }));
      } catch (error) {
        logger.error('Failed to dispatch message send', { error, connectionId: connection.id });
        toast({
          title: 'Message Not Sent',
          description:
            error instanceof Error
              ? error.message
              : 'Could not reach the desktop agent. Is it connected?',
          variant: 'destructive',
        });
        return;
      }

      // Await the agent's real delivery result over WebSocket so we report
      // confirmed vs unconfirmed instead of assuming success (see P0-3). Falls
      // back to "pending" if the result never arrives within the window.
      const delivery = await new Promise<string>((resolve) => {
        const state: {
          settled: boolean;
          timer?: ReturnType<typeof setTimeout>;
          unsubscribe: () => void;
        } = { settled: false, unsubscribe: () => {} };
        const finish = (status: string) => {
          if (state.settled) return;
          state.settled = true;
          if (state.timer) clearTimeout(state.timer);
          deliveryTimeoutRef.current = null;
          state.unsubscribe();
          resolve(status);
        };
        state.timer = setTimeout(() => finish('pending'), 45000);
        // Mirror into a ref so the unmount cleanup can cancel this wait.
        deliveryTimeoutRef.current = state.timer;
        state.unsubscribe = commandService.onCommandMessage(commandId, (msg) => {
          if (msg.action === 'result') {
            const p = msg.data as
              | { deliveryStatus?: string; data?: { deliveryStatus?: string } }
              | undefined;
            finish(p?.data?.deliveryStatus ?? p?.deliveryStatus ?? 'sent');
          } else if (msg.action === 'error') {
            finish('failed');
          }
        });
      });

      if (delivery === 'failed') {
        toast({
          title: 'Message Failed',
          description: `We couldn't send your message to ${recipientName}.`,
          variant: 'destructive',
        });
        return;
      }

      if (delivery === 'delivered' || delivery === 'sent') {
        // Only reflect the message in the thread once delivery is confirmed
        // (the agent also persists the real conversation server-side on send).
        history.addMessage({
          id: `msg-${Date.now()}`,
          content: message,
          timestamp: new Date().toISOString(),
          sender: 'user',
        });
        toast({
          title: 'Message Sent',
          description: `Your message to ${recipientName} was sent.`,
          variant: 'default',
        });
      } else {
        // 'unconfirmed' (agent couldn't detect the sent bubble) or 'pending'
        // (timed out). Do NOT write it into the thread — we can't confirm it
        // landed, and a false record would discourage the user from resending.
        toast({
          title: 'Message Sent — delivery unconfirmed',
          description: `Sent to ${recipientName}, but we couldn't confirm it landed. Check LinkedIn before resending.`,
          variant: 'default',
        });
      }
    },
    [modal.selectedConnection, toast, history]
  );

  // Main generation orchestrator using callbacks instead of polling
  const handleGenerateMessages = useCallback(async () => {
    if (selectedConnections.length === 0 || !conversationTopic.trim()) {
      toast({
        title: 'Missing Requirements',
        description: 'Please select connections and enter a conversation topic.',
        variant: 'destructive',
      });
      return;
    }

    logger.info('Starting message generation workflow', {
      connectionCount: selectedConnections.length,
    });

    // Log connection statuses to diagnose ally filter
    const selectedWithStatus = connections
      .filter((conn) => selectedConnections.includes(conn.id))
      .map((conn) => ({
        id: conn.id,
        status: conn.status,
      }));
    logger.info('Selected connections before ally filter', { connections: selectedWithStatus });

    progressTracker.initializeProgress(selectedConnections.length);
    progressTracker.setLoadingMessage('Preparing message generation...', 0, true);

    workflow.startGenerating();
    errorHandler.clearError();

    const selectedConnectionsData = connections.filter(
      (conn) => selectedConnections.includes(conn.id) && conn.status === 'ally'
    );

    logger.info('Connections after ally filter', {
      count: selectedConnectionsData.length,
      ids: selectedConnectionsData.map((c) => c.id),
    });

    let wasStopped = false;

    for (let i = 0; i < selectedConnectionsData.length; i++) {
      // Check if stopped (use isStopping getter for current state)
      if (workflow.isStopping) {
        progressTracker.resetProgress();
        wasStopped = true;
        break;
      }

      const connection = selectedConnectionsData[i];
      if (!connection) continue;
      const connectionName = `${connection.first_name} ${connection.last_name}`;

      progressTracker.updateProgress(i, connectionName, 'generating');
      progressTracker.setLoadingMessage(
        `Generating message for ${connectionName}...`,
        Math.round((i / selectedConnectionsData.length) * 100),
        true
      );

      let retryCount = 0;
      let shouldContinue = true;

      while (shouldContinue) {
        // Re-check stop state before each attempt
        if (workflow.isStopping) {
          progressTracker.resetProgress();
          wasStopped = true;
          break;
        }

        try {
          logger.info('Generating message for connection', {
            id: connection.id,
            name: connectionName,
          });
          const generatedMessage = await generateMessageForConnection(connection);
          logger.info('Message generated', {
            id: connection.id,
            messageLength: generatedMessage?.length,
            messagePreview: generatedMessage?.substring(0, 80),
          });
          setGeneratedMessages((prev) => new Map(prev).set(connection.id, generatedMessage));

          progressTracker.updateProgress(i, connectionName, 'waiting_approval');
          workflow.awaitApproval();
          modal.openModal(connection);

          // Wait for user action via callback (Promise resolves when callback fires)
          await new Promise<void>((resolve) => {
            continueWorkflowRef.current = resolve;
          });
          continueWorkflowRef.current = null;
          break;
        } catch (error) {
          logger.error('Error generating message', { connectionId: connection.id, error });
          const recoveryAction = await errorHandler.handleError(
            error,
            connection.id,
            connectionName,
            retryCount
          );

          switch (recoveryAction) {
            case 'retry':
              retryCount++;
              progressTracker.setLoadingMessage(
                `Retrying for ${connectionName}... (Attempt ${retryCount + 1})`,
                Math.round((i / selectedConnectionsData.length) * 100),
                true
              );
              continue;
            case 'skip':
              errorHandler.showInfoFeedback(
                `Skipped ${connectionName} due to error.`,
                'Connection Skipped'
              );
              shouldContinue = false;
              break;
            case 'stop':
              progressTracker.resetProgress();
              workflow.setError();
              return;
          }
        }
      }

      // Check if stopped during the inner while loop
      if (wasStopped) break;
    }

    // Only show success if workflow completed normally (not stopped)
    if (!wasStopped && !workflow.isStopping) {
      logger.info('Message generation workflow completed');
      progressTracker.updateProgress(selectedConnectionsData.length, undefined, 'completed');
      errorHandler.showSuccessFeedback(
        `Successfully generated messages for ${selectedConnectionsData.length} connections.`,
        'Generation Complete'
      );
      workflow.complete();

      if (resetTimeoutRef.current) {
        clearTimeout(resetTimeoutRef.current);
      }
      resetTimeoutRef.current = setTimeout(() => {
        resetTimeoutRef.current = null;
        workflow.reset();
        setGeneratedMessages(new Map());
        progressTracker.resetProgress();
      }, 2000);
    } else {
      logger.info('Message generation workflow was stopped');
    }
  }, [
    selectedConnections,
    conversationTopic,
    connections,
    workflow,
    progressTracker,
    modal,
    generateMessageForConnection,
    errorHandler,
    toast,
  ]);

  // Compute current connection name
  const currentConnectionName = useMemo(() => {
    if (workflow.state === 'idle' || workflow.currentIndex >= selectedConnections.length)
      return undefined;
    const currentConnectionId = selectedConnections[workflow.currentIndex];
    const connection = connections.find((conn) => conn.id === currentConnectionId);
    return connection ? `${connection.first_name} ${connection.last_name}` : undefined;
  }, [workflow.state, workflow.currentIndex, selectedConnections, connections]);

  return {
    // Workflow state
    isGeneratingMessages: workflow.isGenerating || workflow.isAwaitingApproval,
    workflowState: workflow.state,

    // Modal state
    messageModalOpen: modal.isOpen,
    selectedConnectionForMessages: modal.selectedConnection,

    // Message state
    messageHistory: history.messages,
    generatedMessages,

    // Derived
    currentConnectionName,
    progressTracker,

    // Actions
    handleMessageClick,
    handleCloseMessageModal,
    handleSendMessage,
    handleGenerateMessages,
    handleStopGeneration,
    handleApproveAndNext,
    handleSkipConnection,
  };
}
