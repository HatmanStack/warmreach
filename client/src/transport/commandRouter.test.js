import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoist mock functions so they're available before vi.mock factories execute
const {
  mockPerformSearchDirect,
  mockSendMessageDirect,
  mockAddConnectionDirect,
  mockInitializeDirect,
} = vi.hoisted(() => ({
  mockPerformSearchDirect: vi.fn(),
  mockSendMessageDirect: vi.fn(),
  mockAddConnectionDirect: vi.fn(),
  mockInitializeDirect: vi.fn(),
}));

// Mock all controllers with class-compatible factories
vi.mock('../domains/search/controllers/searchController.js', () => ({
  SearchController: class {
    performSearchDirect = mockPerformSearchDirect;
  },
}));

vi.mock('../domains/linkedin/controllers/linkedinInteractionController.js', () => ({
  LinkedInInteractionController: class {
    sendMessageDirect = mockSendMessageDirect;
    addConnectionDirect = mockAddConnectionDirect;
  },
}));

vi.mock('../domains/profile/controllers/profileInitController.js', () => ({
  ProfileInitController: class {
    initializeDirect = mockInitializeDirect;
  },
}));

import { handleExecuteCommand, _buildApiCall, LLM_REQUEST_TIMEOUT_MS } from './commandRouter.js';

describe('commandRouter', () => {
  let sendFn;

  beforeEach(() => {
    vi.clearAllMocks();
    sendFn = vi.fn();
  });

  describe('unknown command type', () => {
    it('sends UNKNOWN_COMMAND error for unrecognized types', async () => {
      await handleExecuteCommand({ commandId: 'cmd-1', type: 'unknown:type', payload: {} }, sendFn);

      expect(sendFn).toHaveBeenCalledWith({
        action: 'error',
        commandId: 'cmd-1',
        code: 'UNKNOWN_COMMAND',
        message: 'Unknown command type: unknown:type',
      });
    });
  });

  describe('linkedin:search', () => {
    it('routes to searchController.performSearchDirect and sends result', async () => {
      const mockResult = { profiles: [{ name: 'Alice' }] };
      mockPerformSearchDirect.mockResolvedValueOnce(mockResult);

      await handleExecuteCommand(
        { commandId: 'cmd-2', type: 'linkedin:search', payload: { query: 'AI' } },
        sendFn
      );

      expect(mockPerformSearchDirect).toHaveBeenCalledWith({ query: 'AI' }, expect.any(Function));
      expect(sendFn).toHaveBeenCalledWith({
        action: 'result',
        commandId: 'cmd-2',
        data: mockResult,
      });
    });
  });

  describe('linkedin:send-message', () => {
    it('routes to interactionController.sendMessageDirect', async () => {
      mockSendMessageDirect.mockResolvedValueOnce({ sent: true });

      await handleExecuteCommand(
        { commandId: 'cmd-3', type: 'linkedin:send-message', payload: { to: 'Bob' } },
        sendFn
      );

      expect(mockSendMessageDirect).toHaveBeenCalledWith({ to: 'Bob' }, expect.any(Function));
      expect(sendFn).toHaveBeenCalledWith({
        action: 'result',
        commandId: 'cmd-3',
        data: { sent: true },
      });
    });
  });

  describe('linkedin:add-connection', () => {
    it('routes to interactionController.addConnectionDirect', async () => {
      mockAddConnectionDirect.mockResolvedValueOnce({ requested: true });

      await handleExecuteCommand(
        { commandId: 'cmd-3b', type: 'linkedin:add-connection', payload: { profileUrl: 'url' } },
        sendFn
      );

      expect(mockAddConnectionDirect).toHaveBeenCalled();
      expect(sendFn).toHaveBeenCalledWith({
        action: 'result',
        commandId: 'cmd-3b',
        data: { requested: true },
      });
    });
  });

  describe('linkedin:profile-init', () => {
    it('routes to profileInitController.initializeDirect', async () => {
      mockInitializeDirect.mockResolvedValueOnce({ initialized: true });

      await handleExecuteCommand(
        { commandId: 'cmd-4', type: 'linkedin:profile-init', payload: {} },
        sendFn
      );

      expect(mockInitializeDirect).toHaveBeenCalled();
      expect(sendFn).toHaveBeenCalledWith({
        action: 'result',
        commandId: 'cmd-4',
        data: { initialized: true },
      });
    });
  });

  describe('payload validation at the trust boundary', () => {
    it('rejects a non-object payload with INVALID_PAYLOAD and does not invoke the controller', async () => {
      await handleExecuteCommand(
        { commandId: 'cmd-inv-1', type: 'linkedin:search', payload: 'not-an-object' },
        sendFn
      );

      expect(mockPerformSearchDirect).not.toHaveBeenCalled();
      expect(sendFn).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'error',
          commandId: 'cmd-inv-1',
          code: 'INVALID_PAYLOAD',
        })
      );
    });

    it('rejects a malformed search payload (wrong field type) without invoking the controller', async () => {
      await handleExecuteCommand(
        { commandId: 'cmd-inv-2', type: 'linkedin:search', payload: { companyName: 123 } },
        sendFn
      );

      expect(mockPerformSearchDirect).not.toHaveBeenCalled();
      expect(sendFn).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'error',
          commandId: 'cmd-inv-2',
          code: 'INVALID_PAYLOAD',
          message: expect.stringMatching(/companyName/),
        })
      );
    });

    it('rejects a malformed send-message payload (wrong field type)', async () => {
      await handleExecuteCommand(
        {
          commandId: 'cmd-inv-3',
          type: 'linkedin:send-message',
          payload: { recipientProfileId: 42 },
        },
        sendFn
      );

      expect(mockSendMessageDirect).not.toHaveBeenCalled();
      expect(sendFn).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'error',
          commandId: 'cmd-inv-3',
          code: 'INVALID_PAYLOAD',
        })
      );
    });

    it('rejects a malformed add-connection payload (wrong field type)', async () => {
      await handleExecuteCommand(
        { commandId: 'cmd-inv-4', type: 'linkedin:add-connection', payload: { profileId: {} } },
        sendFn
      );

      expect(mockAddConnectionDirect).not.toHaveBeenCalled();
      expect(sendFn).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'error',
          commandId: 'cmd-inv-4',
          code: 'INVALID_PAYLOAD',
        })
      );
    });

    it('dispatches a valid search payload (validation passes)', async () => {
      mockPerformSearchDirect.mockResolvedValueOnce({ profiles: [] });

      await handleExecuteCommand(
        {
          commandId: 'cmd-valid-1',
          type: 'linkedin:search',
          payload: { query: 'AI', companyName: 'Acme', jwtToken: 'jwt' },
        },
        sendFn
      );

      expect(mockPerformSearchDirect).toHaveBeenCalledWith(
        { query: 'AI', companyName: 'Acme', jwtToken: 'jwt' },
        expect.any(Function)
      );
      expect(sendFn).toHaveBeenCalledWith({
        action: 'result',
        commandId: 'cmd-valid-1',
        data: { profiles: [] },
      });
    });
  });

  describe('progress callback', () => {
    it('sends progress messages through sendFn', async () => {
      mockPerformSearchDirect.mockImplementationOnce(async (payload, onProgress) => {
        onProgress(1, 3, 'Step 1');
        onProgress(2, 3, 'Step 2');
        return { done: true };
      });

      await handleExecuteCommand(
        { commandId: 'cmd-5', type: 'linkedin:search', payload: {} },
        sendFn
      );

      expect(sendFn).toHaveBeenCalledWith({
        action: 'progress',
        commandId: 'cmd-5',
        step: 1,
        total: 3,
        message: 'Step 1',
      });
      expect(sendFn).toHaveBeenCalledWith({
        action: 'progress',
        commandId: 'cmd-5',
        step: 2,
        total: 3,
        message: 'Step 2',
      });
      // Final result
      expect(sendFn).toHaveBeenCalledWith({
        action: 'result',
        commandId: 'cmd-5',
        data: { done: true },
      });
    });
  });

  describe('_buildApiCall LLM fetch timeout', () => {
    let originalFetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    });

    it('rejects with a clear timeout error when the LLM fetch hangs', async () => {
      vi.useFakeTimers();

      // fetch never resolves on its own; it should reject only when the
      // AbortController aborts after LLM_REQUEST_TIMEOUT_MS.
      globalThis.fetch = vi.fn(
        (_url, opts) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          })
      );

      const apiCall = _buildApiCall('jwt-token');
      const promise = apiCall({ prompt: 'hello' });
      // Attach a catch handler immediately so the rejection is observed.
      const expectation = expect(promise).rejects.toThrow(/timed out/i);

      await vi.advanceTimersByTimeAsync(LLM_REQUEST_TIMEOUT_MS + 1);

      await expectation;
    });

    it('clears the timeout and returns parsed JSON on a successful response', async () => {
      vi.useFakeTimers();
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ result: 'ok' }),
      }));

      const apiCall = _buildApiCall(undefined);
      const result = await apiCall({ prompt: 'hi' });

      expect(result).toEqual({ result: 'ok' });
      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });

  describe('error handling', () => {
    it('sends error with code from thrown error', async () => {
      const err = new Error('Rate limited');
      err.code = 'RATE_LIMITED';
      mockPerformSearchDirect.mockRejectedValueOnce(err);

      await handleExecuteCommand(
        { commandId: 'cmd-6', type: 'linkedin:search', payload: {} },
        sendFn
      );

      expect(sendFn).toHaveBeenCalledWith({
        action: 'error',
        commandId: 'cmd-6',
        code: 'RATE_LIMITED',
        message: 'Rate limited',
        details: undefined,
      });
    });

    it('uses EXECUTION_ERROR code when error has no code', async () => {
      mockPerformSearchDirect.mockRejectedValueOnce(new Error('Something broke'));

      await handleExecuteCommand(
        { commandId: 'cmd-7', type: 'linkedin:search', payload: {} },
        sendFn
      );

      expect(sendFn).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'error',
          commandId: 'cmd-7',
          code: 'EXECUTION_ERROR',
          message: 'Something broke',
        })
      );
    });

    it('forwards error details when present', async () => {
      const err = new Error('Validation failed');
      err.code = 'VALIDATION_ERROR';
      err.details = { field: 'query', reason: 'required' };
      mockPerformSearchDirect.mockRejectedValueOnce(err);

      await handleExecuteCommand(
        { commandId: 'cmd-8', type: 'linkedin:search', payload: {} },
        sendFn
      );

      expect(sendFn).toHaveBeenCalledWith({
        action: 'error',
        commandId: 'cmd-8',
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: { field: 'query', reason: 'required' },
      });
    });
  });
});
