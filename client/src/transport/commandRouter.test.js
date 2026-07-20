import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock functions so they're available before vi.mock factories execute
const {
  mockPerformSearchDirect,
  mockSendMessageDirect,
  mockAddConnectionDirect,
  mockFollowProfileDirect,
  mockInitializeDirect,
} = vi.hoisted(() => ({
  mockPerformSearchDirect: vi.fn(),
  mockSendMessageDirect: vi.fn(),
  mockAddConnectionDirect: vi.fn(),
  mockFollowProfileDirect: vi.fn(),
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
    followProfileDirect = mockFollowProfileDirect;
  },
}));

vi.mock('../domains/profile/controllers/profileInitController.js', () => ({
  ProfileInitController: class {
    initializeDirect = mockInitializeDirect;
  },
}));

// The community edition's command router does not make the backend LLM fetch
// that the pro edition's Comment Concierge route relies on, so it exports no
// `_buildApiCall` / `LLM_REQUEST_TIMEOUT_MS`. The pro-only "LLM fetch timeout"
// suite is therefore omitted from this edition's test file.
import { handleExecuteCommand } from './commandRouter.js';

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

  describe('linkedin:follow-profile', () => {
    it('routes to interactionController.followProfileDirect and propagates the genuine status', async () => {
      // follow self-confirms; the router must surface the real follow status
      // the controller returns rather than a hardcoded success.
      const followResult = { success: true, data: { status: 'followed', profileId: 'p-1' } };
      mockFollowProfileDirect.mockResolvedValueOnce(followResult);

      await handleExecuteCommand(
        {
          commandId: 'cmd-follow-1',
          type: 'linkedin:follow-profile',
          payload: { profileId: 'p-1', jwtToken: 'jwt' },
        },
        sendFn
      );

      expect(mockFollowProfileDirect).toHaveBeenCalledWith(
        { profileId: 'p-1', jwtToken: 'jwt' },
        expect.any(Function)
      );
      expect(sendFn).toHaveBeenCalledWith({
        action: 'result',
        commandId: 'cmd-follow-1',
        data: followResult,
      });
    });

    it('rejects a malformed follow-profile payload (wrong field type)', async () => {
      await handleExecuteCommand(
        { commandId: 'cmd-follow-2', type: 'linkedin:follow-profile', payload: { profileId: 42 } },
        sendFn
      );

      expect(mockFollowProfileDirect).not.toHaveBeenCalled();
      expect(sendFn).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'error',
          commandId: 'cmd-follow-2',
          code: 'INVALID_PAYLOAD',
          message: expect.stringMatching(/profileId/),
        })
      );
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
