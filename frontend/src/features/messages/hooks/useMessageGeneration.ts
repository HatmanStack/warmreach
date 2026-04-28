import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useToast } from '@/shared/hooks';
import { useErrorHandler } from '@/shared/hooks';
import { useProgressTracker } from '@/features/workflow';
import { messageGenerationService } from '@/features/messages';
import { connectionDataContextService } from '@/features/connections';
import { useWorkflowStateMachine } from './useWorkflowStateMachine';
import { useMessageModal } from './useMessageModal';
import { useMessageHistory } from './useMessageHistory';
import type { Connection, Message, UserProfile } from '@/types';
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
      logger.info('Sending message', { message, connectionId: modal.selectedConnection?.id });
      toast({
        title: 'Message Sending Not Implemented',
        description: 'Message sending functionality will be available in a future update.',
        variant: 'default',
      });
      if (modal.selectedConnection) {
        const newMessage: Message = {
          id: `msg-${Date.now()}`,
          content: message,
          timestamp: new Date().toISOString(),
          sender: 'user',
        };
        history.addMessage(newMessage);
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

      setTimeout(() => {
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
