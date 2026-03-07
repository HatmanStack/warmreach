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

  it('should handle send message', async () => {
    const { result } = renderHook(() => useMessageGeneration(defaultOptions), { wrapper: Wrapper });

    await act(async () => {
      await result.current.handleMessageClick(mockConnections[0]);
    });

    await act(async () => {
      await result.current.handleSendMessage('A custom message');
    });

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
});
