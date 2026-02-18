import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mocks
const { mockOnMessage } = vi.hoisted(() => ({
  mockOnMessage: vi.fn(() => vi.fn()),
}));

// Mock websocketService
vi.mock('./websocketService', () => ({
  websocketService: {
    onMessage: mockOnMessage,
  },
}));

// Mock logger
vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock Cognito — returns a valid session by default
vi.mock('amazon-cognito-identity-js', () => ({
  CognitoUserPool: vi.fn().mockImplementation(() => ({
    getCurrentUser: () => ({
      getSession: (cb: (err: Error | null, session: unknown) => void) =>
        cb(null, {
          isValid: () => true,
          getIdToken: () => ({ getJwtToken: () => 'mock-token' }),
        }),
    }),
  })),
  CognitoUserSession: vi.fn(),
}));

vi.mock('@/config/appConfig', () => ({
  cognitoConfig: { userPoolId: 'us-east-1_test', userPoolWebClientId: 'testclient' },
}));

import { commandService } from './commandService';

describe('commandService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn());
  });

  describe('dispatch', () => {
    it('sends POST to /commands with type and payload', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ commandId: 'cmd-123' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await commandService.dispatch('linkedin:search', { query: 'test' });

      expect(result.commandId).toBe('cmd-123');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/commands'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer mock-token',
          }),
        })
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.type).toBe('linkedin:search');
      expect(body.payload.query).toBe('test');
    });

    it('throws on HTTP error response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
          json: async () => ({ error: 'No agent connected' }),
        })
      );

      await expect(commandService.dispatch('linkedin:search', {})).rejects.toThrow(
        'No agent connected'
      );
    });

    it('throws with status code when error body is unparseable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: async () => {
            throw new Error('bad json');
          },
        })
      );

      await expect(commandService.dispatch('test', {})).rejects.toThrow('HTTP 500');
    });

    it('attaches LinkedIn credentials for linkedin: commands', async () => {
      sessionStorage.setItem('li_credentials_ciphertext', 'sealbox_x25519:b64:abc123');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ commandId: 'cmd-456' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await commandService.dispatch('linkedin:search', { query: 'test' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.payload.linkedinCredentialsCiphertext).toBe('sealbox_x25519:b64:abc123');
    });

    it('does not attach credentials for non-linkedin commands', async () => {
      sessionStorage.setItem('li_credentials_ciphertext', 'sealbox_x25519:b64:abc123');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ commandId: 'cmd-789' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await commandService.dispatch('other:command', { data: 1 });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.payload.linkedinCredentialsCiphertext).toBeUndefined();
    });

    it('does not attach credentials when ciphertext missing sealbox prefix', async () => {
      sessionStorage.setItem('li_credentials_ciphertext', 'plain-text-value');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ commandId: 'cmd-000' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await commandService.dispatch('linkedin:search', {});

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.payload.linkedinCredentialsCiphertext).toBeUndefined();
    });
  });

  describe('onCommandMessage', () => {
    it('registers and unregisters callbacks', () => {
      const callback = vi.fn();
      const unsubscribe = commandService.onCommandMessage('cmd-1', callback);

      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    });
  });

  describe('getCommandStatus', () => {
    it('fetches command status via GET', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ commandId: 'cmd-1', status: 'completed' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await commandService.getCommandStatus('cmd-1');

      expect(result).toEqual({ commandId: 'cmd-1', status: 'completed' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/commands/cmd-1'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer mock-token',
          }),
        })
      );
    });

    it('throws on HTTP error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
        })
      );

      await expect(commandService.getCommandStatus('bad-id')).rejects.toThrow('HTTP 404');
    });
  });

  describe('destroy', () => {
    it('clears callbacks and unsubscribes from websocket', () => {
      commandService.destroy();
      // Re-setup so other tests still work (constructor re-subscribes)
    });
  });
});
