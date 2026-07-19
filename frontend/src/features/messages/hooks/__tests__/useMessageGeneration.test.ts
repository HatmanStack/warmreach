import { renderHook, act, waitFor } from '@testing-library/react';
import { useMessageGeneration } from '../useMessageGeneration';
import { createWrapper, buildConnection } from '@/test-utils';
import { messageGenerationService } from '@/features/messages';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies
vi.mock('@/shared/hooks', () => ({
  useToast: () => ({ toast: vi.fn() }),
  useErrorHandler: () => ({
    clearError: vi.fn(),
    handleError: vi.fn().mockResolvedValue('skip'),
    showInfoFeedback: vi.fn(),
    showSuccessFeedback: vi.fn(),
  }),
}));

vi.mock('@/features/workflow', () => ({
  useProgressTracker: () => ({
    initializeProgress: vi.fn(),
    setLoadingMessage: vi.fn(),
    updateProgress: vi.fn(),
    resetProgress: vi.fn(),
  }),
}));

vi.mock('@/shared/services/commandService', () => ({
  commandService: {
    dispatch: vi.fn().mockResolvedValue({ commandId: 'cmd-1' }),
    // Deliver a confirmed result immediately so handleSendMessage resolves
    // deterministically without a real WebSocket.
    onCommandMessage: vi.fn((commandId: string, cb: (m: unknown) => void) => {
      cb({ commandId, action: 'result', data: { data: { deliveryStatus: 'delivered' } } });
      return () => {};
    }),
  },
}));

vi.mock('@/features/messages', async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    messageGenerationService: {
      generateMessage: vi.fn(),
    },
  };
});

describe('useMessageGeneration', () => {
  const mockConnections = [
    buildConnection({ id: 'c1', first_name: 'John', status: 'ally' }),
    buildConnection({ id: 'c2', first_name: 'Jane', status: 'ally' }),
  ];

  const defaultOptions = {
    connections: mockConnections,
    selectedConnections: ['c1'],
    conversationTopic: 'Test Topic',
    userProfile: null,
  };

  const Wrapper = createWrapper();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle message click', async () => {
    const { result } = renderHook(() => useMessageGeneration(defaultOptions), { wrapper: Wrapper });

    await act(async () => {
      await result.current.handleMessageClick(mockConnections[0]);
    });

    expect(result.current.selectedConnectionForMessages?.id).toBe('c1');
    expect(result.current.messageModalOpen).toBe(true);
  });

  it('should validate requirements before generating', async () => {
    const { result } = renderHook(
      () => useMessageGeneration({ ...defaultOptions, selectedConnections: [] }),
      { wrapper: Wrapper }
    );

    await act(async () => {
      await result.current.handleGenerateMessages();
    });

    // Should not start generating if no connections selected
    expect(result.current.isGeneratingMessages).toBe(false);
  });

  it('should run generation workflow', async () => {
    vi.mocked(messageGenerationService.generateMessage).mockResolvedValue('Hello John');

    const { result } = renderHook(() => useMessageGeneration(defaultOptions), { wrapper: Wrapper });

    act(() => {
      result.current.handleGenerateMessages();
    });

    // Wait for it to await approval
    await waitFor(() => {
      expect(result.current.workflowState).toBe('awaiting_approval');
    });

    expect(result.current.generatedMessages.get('c1')).toBe('Hello John');
    expect(result.current.messageModalOpen).toBe(true);

    // Approve and next
    act(() => {
      result.current.handleApproveAndNext();
    });

    // Should complete
    await waitFor(
      () => {
        expect(result.current.workflowState).toBe('completed');
      },
      { timeout: 5000 }
    );
  });

  it('should clear the pending reset timeout on unmount', async () => {
    vi.mocked(messageGenerationService.generateMessage).mockResolvedValue('Hello John');

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const { result, unmount } = renderHook(() => useMessageGeneration(defaultOptions), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.handleGenerateMessages();
    });

    await waitFor(() => {
      expect(result.current.workflowState).toBe('awaiting_approval');
    });

    act(() => {
      result.current.handleApproveAndNext();
    });

    // Workflow completes and schedules the 2s reset timeout.
    await waitFor(() => {
      expect(result.current.workflowState).toBe('completed');
    });

    clearTimeoutSpy.mockClear();

    // Unmount before the 2s window elapses; the cleanup effect must clear the timer.
    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('should dispatch the real send-message command and record the message', async () => {
    const { commandService } = await import('@/shared/services/commandService');
    const { result } = renderHook(() => useMessageGeneration(defaultOptions), { wrapper: Wrapper });

    await act(async () => {
      await result.current.handleMessageClick(mockConnections[0]);
    });

    await act(async () => {
      await result.current.handleSendMessage('A custom message');
    });

    // Dispatches the live linkedin:send-message route with the exact payload
    // field names the client's sendMessageDirect expects.
    expect(commandService.dispatch).toHaveBeenCalledWith(
      'linkedin:send-message',
      expect.objectContaining({
        recipientProfileId: expect.any(String),
        messageContent: 'A custom message',
      })
    );
    // On a confirmed delivery the message is reflected in the thread.
    expect(result.current.messageHistory.some((m) => m.content === 'A custom message')).toBe(true);
    expect(result.current.messageModalOpen).toBe(true);
  });

  it('should handle skip connection', async () => {
    vi.mocked(messageGenerationService.generateMessage).mockResolvedValue('Done');
    const { result } = renderHook(() => useMessageGeneration(defaultOptions), { wrapper: Wrapper });

    act(() => {
      result.current.handleGenerateMessages();
    });

    await waitFor(() => {
      expect(result.current.workflowState).toBe('awaiting_approval');
    });

    act(() => {
      result.current.handleSkipConnection();
    });

    await waitFor(() => {
      expect(result.current.workflowState).toBe('completed');
    });
  });

  it('should filter non-ally connections', async () => {
    const mixedConns = [
      buildConnection({ id: 'c1', status: 'ally' }),
      buildConnection({ id: 'c2', status: 'possible' }),
    ];
    const { result } = renderHook(
      () =>
        useMessageGeneration({
          ...defaultOptions,
          connections: mixedConns,
          selectedConnections: ['c1', 'c2'],
        }),
      { wrapper: Wrapper }
    );

    act(() => {
      result.current.handleGenerateMessages();
    });

    // Should only generate for c1
    await waitFor(() => {
      expect(result.current.workflowState).toBe('awaiting_approval');
    });
    expect(result.current.selectedConnectionForMessages?.id).toBe('c1');

    act(() => {
      result.current.handleApproveAndNext();
    });

    await waitFor(() => {
      expect(result.current.workflowState).toBe('completed');
    });
  });

  it('does NOT record the message when the agent reports delivery failed', async () => {
    const { commandService } = await import('@/shared/services/commandService');
    vi.mocked(commandService.onCommandMessage).mockImplementationOnce(
      (commandId: string, cb: (m: unknown) => void) => {
        cb({ commandId, action: 'error' });
        return () => {};
      }
    );

    const { result } = renderHook(() => useMessageGeneration(defaultOptions), { wrapper: Wrapper });
    await act(async () => {
      await result.current.handleMessageClick(mockConnections[0]);
    });
    await act(async () => {
      await result.current.handleSendMessage('Unsent message');
    });

    // A failed send must never appear in the thread as though it went out.
    expect(result.current.messageHistory.some((m) => m.content === 'Unsent message')).toBe(false);
  });

  it('does NOT record the message when delivery is unconfirmed', async () => {
    const { commandService } = await import('@/shared/services/commandService');
    vi.mocked(commandService.onCommandMessage).mockImplementationOnce(
      (commandId: string, cb: (m: unknown) => void) => {
        cb({ commandId, action: 'result', data: { data: { deliveryStatus: 'unconfirmed' } } });
        return () => {};
      }
    );

    const { result } = renderHook(() => useMessageGeneration(defaultOptions), { wrapper: Wrapper });
    await act(async () => {
      await result.current.handleMessageClick(mockConnections[0]);
    });
    await act(async () => {
      await result.current.handleSendMessage('Maybe sent');
    });

    // Unconfirmed delivery must not be recorded — a false record discourages resend.
    expect(result.current.messageHistory.some((m) => m.content === 'Maybe sent')).toBe(false);
  });

  it('clears the in-flight delivery-wait timer on unmount', async () => {
    const { commandService } = await import('@/shared/services/commandService');
    // Never deliver a result, so the 45s delivery timer stays pending.
    vi.mocked(commandService.onCommandMessage).mockImplementationOnce(() => () => {});
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const { result, unmount } = renderHook(() => useMessageGeneration(defaultOptions), {
      wrapper: Wrapper,
    });
    await act(async () => {
      await result.current.handleMessageClick(mockConnections[0]);
    });

    // Kick off the send; it blocks on the delivery Promise (no result arrives).
    act(() => {
      void result.current.handleSendMessage('Pending message');
    });
    await waitFor(() => {
      expect(commandService.dispatch).toHaveBeenCalled();
    });

    clearTimeoutSpy.mockClear();
    unmount();

    // The cleanup effect must cancel the pending delivery timer so it can't fire
    // against a stale closure after the component is gone.
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
