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
