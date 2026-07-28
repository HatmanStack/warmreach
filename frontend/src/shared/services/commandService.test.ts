import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist the messageHandlers mock container
const { messageHandlers, mockPost, mockGet } = vi.hoisted(() => ({
  messageHandlers: [] as any[],
  mockPost: vi.fn(),
  mockGet: vi.fn(),
}));

// Mock websocketService with a way to capture and trigger handlers
vi.mock('./websocketService', () => ({
  websocketService: {
    onMessage: vi.fn().mockImplementation((handler) => {
      messageHandlers.push(handler);
      return () => {
        const index = messageHandlers.indexOf(handler);
        if (index > -1) messageHandlers.splice(index, 1);
      };
    }),
  },
}));

// Mock httpClient
vi.mock('@/shared/utils/httpClient', () => ({
  httpClient: {
    post: mockPost,
    get: mockGet,
  },
}));

// Now import the service under test
import { commandService } from './commandService';

describe('CommandService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  describe('dispatch', () => {
    it('should dispatch command successfully', async () => {
      mockPost.mockResolvedValueOnce({
        success: true,
        data: { commandId: 'cmd-unit-test' },
      });

      const result = await commandService.dispatch('test:op', { foo: 'bar' });
      expect(result.commandId).toBe('cmd-unit-test');
      expect(mockPost).toHaveBeenCalledWith('commands', {
        type: 'test:op',
        payload: { foo: 'bar' },
      });
    });

    it('should attach LinkedIn credentials when required', async () => {
      sessionStorage.setItem('li_credentials_ciphertext', 'sealbox_x25519:b64:valid');

      mockPost.mockResolvedValueOnce({
        success: true,
        data: { commandId: 'cmd-li' },
      });

      await commandService.dispatch('linkedin:search', { query: 'test' });

      expect(mockPost).toHaveBeenCalledWith('commands', {
        type: 'linkedin:search',
        payload: { query: 'test', linkedinCredentialsCiphertext: 'sealbox_x25519:b64:valid' },
      });
    });

    it('should handle API errors with body message', async () => {
      mockPost.mockResolvedValueOnce({
        success: false,
        error: { message: 'Specific error', status: 400 },
      });

      await expect(commandService.dispatch('op', {})).rejects.toThrow('Specific error');
    });

    it('routes outbound LinkedIn actions through the metered /linkedin-actions gate', async () => {
      mockPost.mockResolvedValue({ success: true, data: { commandId: 'cmd-gate' } });

      for (const type of [
        'linkedin:add-connection',
        'linkedin:send-message',
        'linkedin:follow-profile',
      ]) {
        mockPost.mockClear();
        await commandService.dispatch(type, { recipientProfileId: 'p1' });
        expect(mockPost).toHaveBeenCalledWith('linkedin-actions', {
          type,
          payload: { recipientProfileId: 'p1' },
          idempotencyKey: expect.any(String),
        });
      }
    });

    it('keeps non-action commands (including linkedin:search) on /commands', async () => {
      mockPost.mockResolvedValue({ success: true, data: { commandId: 'c' } });

      await commandService.dispatch('linkedin:search', { query: 'x' });
      expect(mockPost).toHaveBeenLastCalledWith(
        'commands',
        expect.objectContaining({ type: 'linkedin:search' })
      );

      await commandService.dispatch('linkedin:profile-init', {});
      expect(mockPost).toHaveBeenLastCalledWith(
        'commands',
        expect.objectContaining({ type: 'linkedin:profile-init' })
      );
    });
  });

  describe('idempotency key', () => {
    const keyOf = (call: unknown[]) => (call[1] as { idempotencyKey?: string }).idempotencyKey;

    it('reuses one key across retries of the same action, so a manual retry cannot duplicate it', async () => {
      mockPost.mockResolvedValueOnce({
        success: false,
        error: { message: 'Dispatch unavailable' },
      });
      await expect(
        commandService.dispatch('linkedin:add-connection', { recipientProfileId: 'p1' })
      ).rejects.toThrow();

      mockPost.mockResolvedValueOnce({ success: true, data: { commandId: 'c1' } });
      await commandService.dispatch('linkedin:add-connection', { recipientProfileId: 'p1' });

      expect(keyOf(mockPost.mock.calls[0]!)).toBe(keyOf(mockPost.mock.calls[1]!));
      expect(keyOf(mockPost.mock.calls[0]!)).toBeTruthy();
    });

    it('issues a fresh key once an action has landed, so a deliberate repeat is not blocked', async () => {
      mockPost.mockResolvedValue({ success: true, data: { commandId: 'c' } });

      await commandService.dispatch('linkedin:follow-profile', { profileId: 'p2' });
      await commandService.dispatch('linkedin:follow-profile', { profileId: 'p2' });

      expect(keyOf(mockPost.mock.calls[0]!)).not.toBe(keyOf(mockPost.mock.calls[1]!));
    });

    it('gives distinct actions distinct keys', async () => {
      mockPost.mockResolvedValue({ success: false, error: { message: 'boom' } });

      await expect(
        commandService.dispatch('linkedin:send-message', { recipientProfileId: 'a' })
      ).rejects.toThrow();
      await expect(
        commandService.dispatch('linkedin:send-message', { recipientProfileId: 'b' })
      ).rejects.toThrow();

      expect(keyOf(mockPost.mock.calls[0]!)).not.toBe(keyOf(mockPost.mock.calls[1]!));
    });

    it('does not attach a key to unmetered /commands dispatches', async () => {
      mockPost.mockResolvedValue({ success: true, data: { commandId: 'c' } });

      await commandService.dispatch('linkedin:search', { query: 'x' });

      expect(mockPost).toHaveBeenCalledWith('commands', {
        type: 'linkedin:search',
        payload: { query: 'x' },
      });
    });

    it('does not grow the pending-key map without bound', async () => {
      mockPost.mockResolvedValue({ success: false, error: { message: 'boom' } });

      for (let i = 0; i < 120; i++) {
        await expect(
          commandService.dispatch('linkedin:add-connection', { recipientProfileId: `bulk-${i}` })
        ).rejects.toThrow();
      }

      expect(commandService.pendingIdempotencyKeyCount).toBeLessThanOrEqual(50);
    });
  });

  describe('WebSocket handling', () => {
    it('should route messages to callbacks and cleanup on terminal status', () => {
      const callback = vi.fn();
      commandService.onCommandMessage('cmd-ws-1', callback);

      // Trigger message via all registered handlers
      const msg = { commandId: 'cmd-ws-1', action: 'progress', step: 1, total: 2 };
      messageHandlers.forEach((handler) => handler(msg));

      expect(callback).toHaveBeenCalledWith(msg);

      // terminal message
      const resultMsg = { commandId: 'cmd-ws-1', action: 'result', data: {} };
      messageHandlers.forEach((handler) => handler(resultMsg));
      expect(callback).toHaveBeenCalledWith(resultMsg);

      // cleanup test
      callback.mockClear();
      messageHandlers.forEach((handler) => handler(msg));
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
