import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test-utils';

// Hoist the messageHandlers mock container
const { messageHandlers } = vi.hoisted(() => ({
  messageHandlers: [] as any[],
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

// Now import the service under test
import { commandService } from './commandService';

describe('CommandService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    server.resetHandlers();
  });

  describe('dispatch', () => {
    it('should dispatch command successfully', async () => {
      server.use(
        http.post('*/commands', () => {
          return HttpResponse.json({ commandId: 'cmd-unit-test' });
        })
      );

      vi.spyOn(commandService as any, '_getCognitoToken').mockResolvedValue('mock-token');

      const result = await commandService.dispatch('test:op', { foo: 'bar' });
      expect(result.commandId).toBe('cmd-unit-test');
    });

    it('should attach LinkedIn credentials when required', async () => {
      sessionStorage.setItem('li_credentials_ciphertext', 'sealbox_x25519:b64:valid');

      let capturedBody: any;
      server.use(
        http.post('*/commands', async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({ commandId: 'cmd-li' });
        })
      );

      vi.spyOn(commandService as any, '_getCognitoToken').mockResolvedValue('mock-token');

      await commandService.dispatch('linkedin:search', { query: 'test' });

      expect(capturedBody.payload.linkedinCredentialsCiphertext).toBe('sealbox_x25519:b64:valid');
    });

    it('should handle API errors with body message', async () => {
      server.use(
        http.post('*/commands', () => {
          return HttpResponse.json({ error: 'Specific error' }, { status: 400 });
        })
      );
      vi.spyOn(commandService as any, '_getCognitoToken').mockResolvedValue('mock-token');

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
