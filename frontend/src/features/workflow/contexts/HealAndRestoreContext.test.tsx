import { render, screen, act } from '@testing-library/react';
import { HealAndRestoreProvider, useHealAndRestore } from './HealAndRestoreContext';
import { healAndRestoreService } from '@/features/workflow';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/features/workflow', async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    healAndRestoreService: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      startListening: vi.fn(),
      stopListening: vi.fn(),
      authorizeHealAndRestore: vi.fn(),
      cancelHealAndRestore: vi.fn(),
    },
    HealAndRestoreModal: ({ onAuthorize, onCancel }: any) => (
      <div data-testid="mock-modal">
        <button onClick={() => onAuthorize(true)}>Authorize</button>
        <button onClick={() => onCancel()}>Cancel</button>
      </div>
    ),
  };
});

const TestConsumer = () => {
  const { isListening, startListening, stopListening } = useHealAndRestore();
  return (
    <div>
      <span data-testid="listening">{isListening ? 'yes' : 'no'}</span>
      <button onClick={startListening}>Start</button>
      <button onClick={stopListening}>Stop</button>
    </div>
  );
};

describe('HealAndRestoreContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should start and stop listening', () => {
    render(
      <HealAndRestoreProvider>
        <TestConsumer />
      </HealAndRestoreProvider>
    );

    expect(screen.getByTestId('listening')).toHaveTextContent('no');

    act(() => {
      screen.getByText('Start').click();
    });
    expect(screen.getByTestId('listening')).toHaveTextContent('yes');
    expect(healAndRestoreService.startListening).toHaveBeenCalled();

    act(() => {
      screen.getByText('Stop').click();
    });
    expect(screen.getByTestId('listening')).toHaveTextContent('no');
    expect(healAndRestoreService.stopListening).toHaveBeenCalled();
  });

  it('should show modal on notification and handle authorization', async () => {
    let listener: any;
    vi.mocked(healAndRestoreService.addListener).mockImplementation((l) => {
      listener = l;
    });

    render(
      <HealAndRestoreProvider>
        <TestConsumer />
      </HealAndRestoreProvider>
    );

    act(() => {
      listener({ sessionId: 's1' });
    });

    expect(screen.getByTestId('mock-modal')).toBeInTheDocument();

    vi.mocked(healAndRestoreService.authorizeHealAndRestore).mockResolvedValue(true);

    await act(async () => {
      screen.getByText('Authorize').click();
    });

    expect(healAndRestoreService.authorizeHealAndRestore).toHaveBeenCalledWith('s1', true);
    expect(screen.queryByTestId('mock-modal')).not.toBeInTheDocument();
  });

  it('should handle authorization failure', async () => {
    let listener: any;
    vi.mocked(healAndRestoreService.addListener).mockImplementation((l) => {
      listener = l;
    });

    render(
      <HealAndRestoreProvider>
        <TestConsumer />
      </HealAndRestoreProvider>
    );

    act(() => {
      listener({ sessionId: 's1' });
    });

    vi.mocked(healAndRestoreService.authorizeHealAndRestore).mockResolvedValue(false);

    await act(async () => {
      screen.getByText('Authorize').click();
    });

    expect(healAndRestoreService.authorizeHealAndRestore).toHaveBeenCalled();
    expect(screen.queryByTestId('mock-modal')).not.toBeInTheDocument();
  });

  it('should handle cancellation', async () => {
    let listener: any;
    vi.mocked(healAndRestoreService.addListener).mockImplementation((l) => {
      listener = l;
    });

    render(
      <HealAndRestoreProvider>
        <TestConsumer />
      </HealAndRestoreProvider>
    );

    act(() => {
      listener({ sessionId: 's1' });
    });

    await act(async () => {
      screen.getByText('Cancel').click();
    });

    expect(healAndRestoreService.cancelHealAndRestore).toHaveBeenCalledWith('s1');
    expect(screen.queryByTestId('mock-modal')).not.toBeInTheDocument();
  });

  it('should cleanup on unmount', () => {
    const { unmount } = render(
      <HealAndRestoreProvider>
        <TestConsumer />
      </HealAndRestoreProvider>
    );

    unmount();
    expect(healAndRestoreService.removeListener).toHaveBeenCalled();
    expect(healAndRestoreService.stopListening).toHaveBeenCalled();
  });
});
