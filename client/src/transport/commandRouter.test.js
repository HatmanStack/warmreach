import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
import { handleExecuteCommand, ROUTES } from './commandRouter.js';
import { logger } from '#utils/logger.js';

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

  describe('router-level serialization of browser commands (MEDIUM #17)', () => {
    it('declares an explicit browser flag on every route', () => {
      const entries = Object.entries(ROUTES);
      expect(entries.length).toBeGreaterThan(0);
      for (const [type, route] of entries) {
        expect(typeof route.browser, `${type} must declare browser`).toBe('boolean');
      }
    });

    it('marks every linkedin: route as browser-driving', () => {
      // Every route in this edition drives the browser — the pro edition's
      // github:* routes, which are the `browser: false` case, are not shipped
      // here. The flag stays explicit so the first non-browser route added
      // cannot inherit serialization by accident.
      for (const [type, route] of Object.entries(ROUTES)) {
        expect(route.browser, type).toBe(true);
      }
    });

    it('runs two browser commands strictly in sequence, never overlapping', async () => {
      const events = [];
      let releaseFirst;
      mockInitializeDirect.mockImplementationOnce(async () => {
        events.push('profile-init:start');
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
        events.push('profile-init:end');
        return { initialized: true };
      });
      mockSendMessageDirect.mockImplementationOnce(async () => {
        events.push('send-message:start');
        events.push('send-message:end');
        return { sent: true };
      });

      const first = handleExecuteCommand(
        { commandId: 'c-1', type: 'linkedin:profile-init', payload: {} },
        sendFn
      );
      const second = handleExecuteCommand(
        { commandId: 'c-2', type: 'linkedin:send-message', payload: {} },
        sendFn
      );

      // Let the queue turn over as far as it can while the first job is held.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(events).toEqual(['profile-init:start']);
      expect(mockSendMessageDirect).not.toHaveBeenCalled();

      releaseFirst();
      await Promise.all([first, second]);

      expect(events).toEqual([
        'profile-init:start',
        'profile-init:end',
        'send-message:start',
        'send-message:end',
      ]);
    });

    // The pro edition additionally asserts that a `browser: false` route
    // (github:*) is not parked behind a long profile-init. This edition ships
    // no non-browser route, so there is nothing here to assert it against.

    it('does not wedge the queue when a browser command fails', async () => {
      mockPerformSearchDirect.mockRejectedValueOnce(new Error('navigation failed'));
      mockSendMessageDirect.mockResolvedValueOnce({ sent: true });

      await handleExecuteCommand(
        { commandId: 'c-fail', type: 'linkedin:search', payload: {} },
        sendFn
      );
      await handleExecuteCommand(
        { commandId: 'c-next', type: 'linkedin:send-message', payload: {} },
        sendFn
      );

      expect(sendFn).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'error', commandId: 'c-fail' })
      );
      expect(sendFn).toHaveBeenCalledWith({
        action: 'result',
        commandId: 'c-next',
        data: { sent: true },
      });
    });
  });

  describe('per-route wall-clock deadlines (MEDIUM #18)', () => {
    // A handler that outlives its deadline keeps running — that is the whole
    // point of "the deadline races the handler, it does not cancel it" — and
    // keeps occupying the interaction queue's single slot. Release every one
    // before the next test, or the shared singleton stays blocked.
    const releaseHandlers = [];

    afterEach(async () => {
      releaseHandlers.splice(0).forEach((release) => release());
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it('declares a positive timeoutMs on every route', () => {
      for (const [type, route] of Object.entries(ROUTES)) {
        expect(typeof route.timeoutMs, `${type} must declare timeoutMs`).toBe('number');
        expect(route.timeoutMs, type).toBeGreaterThan(0);
      }
    });

    it('gives the long batch routes more budget than a single interaction', () => {
      expect(ROUTES['linkedin:profile-init'].timeoutMs).toBeGreaterThan(
        ROUTES['linkedin:send-message'].timeoutMs
      );
      expect(ROUTES['linkedin:search'].timeoutMs).toBeGreaterThan(
        ROUTES['linkedin:send-message'].timeoutMs
      );
    });

    it('emits a terminal COMMAND_OUTCOME_UNKNOWN frame when the handler exceeds its budget', async () => {
      vi.useFakeTimers();
      mockSendMessageDirect.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseHandlers.push(() => resolve({ sent: true }));
          })
      );

      const pending = handleExecuteCommand(
        { commandId: 'cmd-slow', type: 'linkedin:send-message', payload: {} },
        sendFn
      );
      await vi.advanceTimersByTimeAsync(ROUTES['linkedin:send-message'].timeoutMs + 1);
      await pending;

      expect(sendFn).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'error',
          commandId: 'cmd-slow',
          code: 'COMMAND_OUTCOME_UNKNOWN',
          message: expect.stringContaining(String(ROUTES['linkedin:send-message'].timeoutMs)),
        })
      );
    });

    it('suppresses a result that arrives after the timeout already reported', async () => {
      vi.useFakeTimers();
      let finishLate;
      mockSendMessageDirect.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishLate = () => resolve({ sent: true });
          })
      );

      const pending = handleExecuteCommand(
        { commandId: 'cmd-late', type: 'linkedin:send-message', payload: {} },
        sendFn
      );
      await vi.advanceTimersByTimeAsync(ROUTES['linkedin:send-message'].timeoutMs + 1);
      await pending;

      const framesAfterTimeout = sendFn.mock.calls.length;
      finishLate();
      await vi.advanceTimersByTimeAsync(10);

      // Exactly one terminal frame for this commandId, and it is the timeout.
      expect(sendFn.mock.calls.length).toBe(framesAfterTimeout);
      expect(
        sendFn.mock.calls.filter(([f]) => f.commandId === 'cmd-late' && f.action === 'result')
      ).toHaveLength(0);
      expect(
        sendFn.mock.calls.filter(([f]) => f.commandId === 'cmd-late' && f.action === 'error')
      ).toHaveLength(1);
    });

    it('suppresses progress frames emitted after the command already timed out', async () => {
      vi.useFakeTimers();
      let lateProgress;
      mockSendMessageDirect.mockImplementationOnce(
        (_payload, onProgress) =>
          new Promise((resolve) => {
            lateProgress = () => onProgress(9, 10, 'still going');
            releaseHandlers.push(() => resolve({ sent: true }));
          })
      );

      const pending = handleExecuteCommand(
        { commandId: 'cmd-lp', type: 'linkedin:send-message', payload: {} },
        sendFn
      );
      await vi.advanceTimersByTimeAsync(ROUTES['linkedin:send-message'].timeoutMs + 1);
      await pending;

      lateProgress();
      expect(
        sendFn.mock.calls.filter(([f]) => f.commandId === 'cmd-lp' && f.action === 'progress')
      ).toHaveLength(0);
    });

    it('drops a still-queued command at its deadline rather than running it later', async () => {
      // The regression this guards: profile-init (60min) and send-message
      // (3min) share the queue's single slot, so an interaction dispatched
      // during a routine import exhausts its whole budget while still queued.
      // Reporting COMMAND_TIMEOUT and then performing the LinkedIn action
      // minutes later is the exact state divergence this phase exists to close
      // — and it re-opens, from the client side, the double-send hole that the
      // backend's claim-before-send is there to prevent.
      vi.useFakeTimers();
      mockInitializeDirect.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseHandlers.push(() => resolve({ initialized: true }));
          })
      );
      mockSendMessageDirect.mockResolvedValue({ sent: true });

      const importRun = handleExecuteCommand(
        { commandId: 'c-import', type: 'linkedin:profile-init', payload: {} },
        sendFn
      );
      const queued = handleExecuteCommand(
        { commandId: 'c-msg', type: 'linkedin:send-message', payload: {} },
        sendFn
      );

      await vi.advanceTimersByTimeAsync(ROUTES['linkedin:send-message'].timeoutMs + 1);
      await queued;

      expect(sendFn).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'error',
          commandId: 'c-msg',
          code: 'COMMAND_TIMEOUT',
        })
      );
      expect(mockSendMessageDirect).not.toHaveBeenCalled();

      // Draining the import must NOT then perform the action already reported
      // as failed.
      releaseHandlers.splice(0).forEach((release) => release());
      await vi.advanceTimersByTimeAsync(1000);
      await importRun;

      expect(mockSendMessageDirect).not.toHaveBeenCalled();
      expect(
        sendFn.mock.calls.filter(([f]) => f.commandId === 'c-msg' && f.action === 'result')
      ).toHaveLength(0);
    });

    it('says the command never started when it was dropped from the queue', async () => {
      vi.useFakeTimers();
      mockInitializeDirect.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseHandlers.push(() => resolve({ initialized: true }));
          })
      );

      const importRun = handleExecuteCommand(
        { commandId: 'c-import-2', type: 'linkedin:profile-init', payload: {} },
        sendFn
      );
      const queued = handleExecuteCommand(
        { commandId: 'c-msg-2', type: 'linkedin:send-message', payload: {} },
        sendFn
      );
      await vi.advanceTimersByTimeAsync(ROUTES['linkedin:send-message'].timeoutMs + 1);
      await queued;

      const frame = sendFn.mock.calls.map(([f]) => f).find((f) => f.commandId === 'c-msg-2');
      expect(frame.message).toMatch(/never started/i);

      releaseHandlers.splice(0).forEach((release) => release());
      await importRun;
    });

    it('still reports an overrun for a handler that is actually running', async () => {
      // The other half of the contract: a running Puppeteer batch cannot be
      // safely aborted mid-navigation, so it is raced rather than cancelled and
      // the message must not claim it never started.
      vi.useFakeTimers();
      mockSendMessageDirect.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseHandlers.push(() => resolve({ sent: true }));
          })
      );

      const pending = handleExecuteCommand(
        { commandId: 'c-running', type: 'linkedin:send-message', payload: {} },
        sendFn
      );
      await vi.advanceTimersByTimeAsync(ROUTES['linkedin:send-message'].timeoutMs + 1);
      await pending;

      const frame = sendFn.mock.calls.map(([f]) => f).find((f) => f.commandId === 'c-running');
      expect(frame.code).toBe('COMMAND_OUTCOME_UNKNOWN');
      expect(frame.message).toMatch(/wall-clock budget/);
      // The code alone is not enough: the user acts on the message. It must say
      // the action may already have happened, because a blind retry mints a
      // fresh idempotency key and sends it a second time.
      expect(frame.message).toMatch(/may already have been performed/i);
      expect(frame.message).toMatch(/retrying may repeat it/i);
      expect(mockSendMessageDirect).toHaveBeenCalledOnce();
    });

    it('leaves a handler that completes inside its budget unaffected', async () => {
      vi.useFakeTimers();
      mockSendMessageDirect.mockImplementationOnce(
        (_payload, onProgress) =>
          new Promise((resolve) =>
            setTimeout(() => {
              onProgress(1, 1, 'done');
              resolve({ sent: true });
            }, 1000)
          )
      );

      const pending = handleExecuteCommand(
        { commandId: 'cmd-fast', type: 'linkedin:send-message', payload: {} },
        sendFn
      );
      await vi.advanceTimersByTimeAsync(2000);
      await pending;

      expect(sendFn).toHaveBeenCalledWith({
        action: 'progress',
        commandId: 'cmd-fast',
        step: 1,
        total: 1,
        message: 'done',
      });
      expect(sendFn).toHaveBeenCalledWith({
        action: 'result',
        commandId: 'cmd-fast',
        data: { sent: true },
      });
      expect(
        sendFn.mock.calls.filter(
          ([f]) => f.code === 'COMMAND_TIMEOUT' || f.code === 'COMMAND_OUTCOME_UNKNOWN'
        )
      ).toHaveLength(0);
    });
  });

  describe('a failing sendFn is never fatal (MEDIUM #23)', () => {
    // In the Electron main process, sendFn closes over a module-level wsClient
    // that restartWebSocket() could set to null mid-command, so every call
    // threw a TypeError — including the one inside the catch block, whose
    // second throw escaped as an unhandled rejection because
    // handleExecuteCommand was never awaited.
    const throwingSend = () => {
      throw new TypeError("Cannot read properties of null (reading 'send')");
    };

    it('completes normally and logs when every frame fails to send', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const sendSpy = vi.fn(throwingSend);
        mockPerformSearchDirect.mockImplementationOnce(async (_payload, onProgress) => {
          onProgress(1, 2, 'step one');
          return { ok: true };
        });

        await expect(
          handleExecuteCommand(
            { commandId: 'c-throw', type: 'linkedin:search', payload: {} },
            sendSpy
          )
        ).resolves.toBeUndefined();

        // The progress frame and the result frame were both attempted and both
        // failed; neither propagated into the handler or out of the router.
        expect(sendSpy).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledTimes(2);

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('does not let the catch block rethrow the failure it is handling', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const sendSpy = vi.fn(throwingSend);
        mockPerformSearchDirect.mockRejectedValueOnce(new Error('navigation failed'));

        await expect(
          handleExecuteCommand(
            { commandId: 'c-throw-2', type: 'linkedin:search', payload: {} },
            sendSpy
          )
        ).resolves.toBeUndefined();

        // Exactly one terminal frame attempted — the error frame — and its own
        // failure did not produce a second throw.
        expect(sendSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy.mock.calls[0][0]).toMatchObject({
          action: 'error',
          commandId: 'c-throw-2',
        });

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('routes the unknown-command and invalid-payload frames through safeSend too', async () => {
      const sendSpy = vi.fn(throwingSend);

      await expect(
        handleExecuteCommand({ commandId: 'c-unk', type: 'nope:nope', payload: {} }, sendSpy)
      ).resolves.toBeUndefined();
      await expect(
        handleExecuteCommand(
          { commandId: 'c-bad', type: 'linkedin:search', payload: { companyName: 123 } },
          sendSpy
        )
      ).resolves.toBeUndefined();

      expect(sendSpy).toHaveBeenCalledTimes(2);
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
