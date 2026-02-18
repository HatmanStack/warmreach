import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
const mockOnMessage = vi.fn();

vi.mock('@/shared/services', () => ({
  websocketService: {
    send: (...args: unknown[]) => mockSend(...args),
    onMessage: (...args: unknown[]) => mockOnMessage(...args),
  },
  lambdaApiService: {},
  commandService: {},
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { healAndRestoreService } from './healAndRestoreService';

describe('HealAndRestoreService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    healAndRestoreService.stopListening();
  });

  describe('isAutoApproveEnabled / setAutoApprove', () => {
    it('should default to false', () => {
      expect(healAndRestoreService.isAutoApproveEnabled()).toBe(false);
    });

    it('should enable auto-approve via sessionStorage', () => {
      healAndRestoreService.setAutoApprove(true);
      expect(healAndRestoreService.isAutoApproveEnabled()).toBe(true);
      expect(sessionStorage.getItem('autoApproveHealRestore')).toBe('true');
    });

    it('should disable auto-approve by removing key', () => {
      healAndRestoreService.setAutoApprove(true);
      healAndRestoreService.setAutoApprove(false);
      expect(healAndRestoreService.isAutoApproveEnabled()).toBe(false);
      expect(sessionStorage.getItem('autoApproveHealRestore')).toBeNull();
    });
  });

  describe('authorizeHealAndRestore', () => {
    it('should send via WebSocket and return result', async () => {
      mockSend.mockReturnValue(true);

      const result = await healAndRestoreService.authorizeHealAndRestore('session-1');

      expect(result).toBe(true);
      expect(mockSend).toHaveBeenCalledWith({
        action: 'heal_authorize',
        sessionId: 'session-1',
        autoApprove: false,
      });
    });

    it('should return false on error', async () => {
      mockSend.mockImplementation(() => {
        throw new Error('Not connected');
      });

      const result = await healAndRestoreService.authorizeHealAndRestore('session-1');

      expect(result).toBe(false);
    });
  });

  describe('cancelHealAndRestore', () => {
    it('should send via WebSocket and add to ignored set', async () => {
      mockSend.mockReturnValue(true);

      const result = await healAndRestoreService.cancelHealAndRestore('session-2');

      expect(result).toBe(true);
      expect(mockSend).toHaveBeenCalledWith({
        action: 'heal_cancel',
        sessionId: 'session-2',
      });
    });

    it('should still ignore session on error', async () => {
      mockSend.mockImplementation(() => {
        throw new Error('Failed');
      });

      const result = await healAndRestoreService.cancelHealAndRestore('session-3');

      expect(result).toBe(false);
    });
  });

  describe('listener subscription', () => {
    it('should add and notify listeners via WebSocket message', () => {
      const listener = vi.fn();
      healAndRestoreService.addListener(listener);

      // Capture the WebSocket message handler
      let messageHandler: (msg: Record<string, unknown>) => void;
      mockOnMessage.mockImplementation((handler: (msg: Record<string, unknown>) => void) => {
        messageHandler = handler;
        return vi.fn(); // unsubscribe
      });

      healAndRestoreService.startListening();

      // Simulate a heal_request message
      messageHandler!({ action: 'heal_request', sessionId: 'sess-1' });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-1',
          message: 'Heal and restore authorization required',
        })
      );

      healAndRestoreService.removeListener(listener);
      healAndRestoreService.stopListening();
    });

    it('should not notify for ignored sessions', async () => {
      const listener = vi.fn();
      healAndRestoreService.addListener(listener);

      // Cancel a session to add to ignored set
      mockSend.mockReturnValue(true);
      await healAndRestoreService.cancelHealAndRestore('sess-ignored');

      // Capture the WebSocket message handler
      let messageHandler: (msg: Record<string, unknown>) => void;
      mockOnMessage.mockImplementation((handler: (msg: Record<string, unknown>) => void) => {
        messageHandler = handler;
        return vi.fn();
      });

      healAndRestoreService.startListening();

      // Simulate a heal_request for the ignored session
      messageHandler!({ action: 'heal_request', sessionId: 'sess-ignored' });

      expect(listener).not.toHaveBeenCalled();

      healAndRestoreService.removeListener(listener);
      healAndRestoreService.stopListening();
    });

    it('should remove listener correctly', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      healAndRestoreService.addListener(listener1);
      healAndRestoreService.addListener(listener2);
      healAndRestoreService.removeListener(listener1);

      // Only listener2 should remain
    });
  });

  describe('startListening / stopListening', () => {
    it('should start listening via WebSocket on startListening', () => {
      mockOnMessage.mockReturnValue(vi.fn());
      healAndRestoreService.startListening();

      expect(mockOnMessage).toHaveBeenCalled();

      healAndRestoreService.stopListening();
    });

    it('should stop listening on stopListening', () => {
      healAndRestoreService.stopListening();
      // No errors
    });
  });
});
