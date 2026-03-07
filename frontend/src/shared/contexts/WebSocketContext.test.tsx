import { render, waitFor } from '@testing-library/react';
import { useAuth } from '@/features/auth';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use hoisted mock
const { mockWs } = vi.hoisted(() => ({
  mockWs: {
    configure: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    onStateChange: vi.fn().mockReturnValue(() => {}),
    onMessage: vi.fn().mockReturnValue(() => {}),
  },
}));

vi.mock('@/features/auth');
vi.mock('@/shared/services/websocketService', () => ({
  websocketService: mockWs,
}));

describe('WebSocketContext', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('should connect when user is authenticated', async () => {
    vi.stubEnv('VITE_WEBSOCKET_URL', 'ws://test');
    vi.mocked(useAuth).mockReturnValue({
      user: { id: 'u1' },
      getToken: vi.fn().mockResolvedValue('token'),
    } as any);

    const { WebSocketProvider } = await import('./WebSocketContext');
    render(
      <WebSocketProvider>
        <div>Test</div>
      </WebSocketProvider>
    );

    await waitFor(
      () => {
        expect(mockWs.connect).toHaveBeenCalledWith('token');
      },
      { timeout: 2000 }
    );
  });

  it('should disconnect when user is not authenticated', async () => {
    vi.stubEnv('VITE_WEBSOCKET_URL', 'ws://test');
    // Initially authenticated
    const mockUseAuth = vi.mocked(useAuth);
    mockUseAuth.mockReturnValueOnce({
      user: { id: 'u1' },
      getToken: vi.fn().mockResolvedValue('token'),
    } as any);

    const { WebSocketProvider } = await import('./WebSocketContext');
    const { rerender } = render(
      <WebSocketProvider>
        <div>Test</div>
      </WebSocketProvider>
    );

    // Now unauthenticate
    mockUseAuth.mockReturnValue({
      user: null,
      getToken: vi.fn(),
    } as any);

    rerender(
      <WebSocketProvider>
        <div>Test</div>
      </WebSocketProvider>
    );

    await waitFor(
      () => {
        expect(mockWs.disconnect).toHaveBeenCalled();
      },
      { timeout: 2000 }
    );
  });
});
