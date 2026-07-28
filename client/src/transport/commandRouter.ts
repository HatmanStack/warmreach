/**
 * Command router - maps execute messages from the backend to controller Direct methods.
 *
 * Each command type maps to a controller method that accepts structured payloads
 * and returns results (no Express req/res dependency).
 *
 * Note: the community edition's command router only routes the core LinkedIn
 * commands and does not make the backend LLM fetch that the pro edition's
 * Comment Concierge route relies on. The AbortController timeout that bounds that
 * pro-only LLM fetch therefore has no counterpart here — there is no un-timed
 * external fetch in this router to bound.
 *
 * Likewise, the community router does not construct the pro edition's GitHub
 * controller (portfolio metrics). The pro edition namespaces that controller's
 * encrypted electron-store as `github-store` so it can't collide with the main
 * `config.json` store; the community router has no such store, so there is
 * nothing to namespace here.
 */

import { logger } from '#utils/logger.js';
import { linkedInInteractionQueue } from '../domains/automation/utils/interactionQueue.js';
import { SearchController } from '../domains/search/controllers/searchController.js';
import { LinkedInInteractionController } from '../domains/linkedin/controllers/linkedinInteractionController.js';
import { ProfileInitController } from '../domains/profile/controllers/profileInitController.js';
import {
  validateCommandPayload,
  type AnyCommandPayload,
  type SendMessageCommandPayload,
  type AddConnectionCommandPayload,
  type FollowProfileCommandPayload,
} from './commandRouter.schemas.js';

type ProgressCallback = (...args: unknown[]) => void;

// Payloads are validated per-command at the dispatch boundary (see
// commandRouter.schemas.ts) before reaching a controller that drives browser
// automation, replacing the former untyped `Record<string, any>`.
type CommandPayload = AnyCommandPayload;

interface CommandRoute {
  handler: (payload: CommandPayload, onProgress: ProgressCallback) => Promise<unknown>;
  /**
   * Whether this handler drives the shared singleton Puppeteer page. Required
   * rather than inferred from the `linkedin:` prefix so that adding a
   * non-browser `linkedin:*` command — or a browser-driving command under some
   * other prefix — cannot silently get the wrong policy.
   *
   * `true` routes run one at a time through `linkedInInteractionQueue`;
   * `false` routes (pure HTTP) run concurrently and must never be parked
   * behind a 60-minute profile-init batch. Every route in the community
   * edition is browser-driving today; the flag stays explicit so that stops
   * being an accident the moment one is not.
   */
  browser: boolean;
  /**
   * Wall-clock ceiling for the whole handler. Required with no default: a
   * route that forgot to declare one would be silently unbounded, which is the
   * defect this replaces — the client could sit on a command forever while the
   * backend's COMMAND# waited on it.
   *
   * The deadline RACES the handler; it does not cancel it. A Puppeteer batch
   * cannot be safely aborted mid-navigation, so a timed-out handler keeps
   * running to completion in the background. That is exactly why `browser`
   * serialization above matters: the next command queues behind the runaway
   * rather than racing it on the shared page.
   */
  timeoutMs: number;
}

const MINUTE_MS = 60_000;

interface ExecuteMessage {
  action: string;
  commandId: string;
  type: string;
  payload: CommandPayload;
}

interface CommandError extends Error {
  code?: string;
  details?: unknown;
}

type SendFn = (data: Record<string, unknown>) => void;

const searchController = new SearchController();
const interactionController = new LinkedInInteractionController();
const profileInitController = new ProfileInitController();

/**
 * Route map: command type -> { controller, method }
 * Direct methods accept (payload, progressCallback) and return result objects.
 *
 * Exported so tests can assert every entry declares its policy fields.
 */
export const ROUTES: Record<string, CommandRoute> = {
  'linkedin:search': {
    timeoutMs: 15 * MINUTE_MS, // multi-page result collection with human-paced delays
    browser: true,
    handler: (payload, onProgress) => searchController.performSearchDirect(payload, onProgress),
  },
  'linkedin:send-message': {
    timeoutMs: 3 * MINUTE_MS, // single interaction plus login/navigation
    browser: true,
    handler: (payload, onProgress) =>
      interactionController.sendMessageDirect(payload as SendMessageCommandPayload, onProgress),
  },
  'linkedin:add-connection': {
    timeoutMs: 3 * MINUTE_MS, // single interaction plus login/navigation
    browser: true,
    handler: (payload, onProgress) =>
      interactionController.addConnectionDirect(payload as AddConnectionCommandPayload, onProgress),
  },
  'linkedin:follow-profile': {
    timeoutMs: 3 * MINUTE_MS, // single interaction plus login/navigation
    browser: true,
    handler: (payload, onProgress) =>
      interactionController.followProfileDirect(payload as FollowProfileCommandPayload, onProgress),
  },
  'linkedin:profile-init': {
    timeoutMs: 60 * MINUTE_MS, // full batch import; the longest legitimate run
    browser: true,
    handler: (payload, onProgress) => profileInitController.initializeDirect(payload, onProgress),
  },
};

/**
 * A promise that rejects once `timeoutMs` elapses, with whatever error
 * `onExpire` returns, paired with the handle needed to cancel it.
 *
 * `onExpire` runs inside the timer callback so it can act on expiry — the
 * router uses it to drop a job still waiting in the browser queue — and then
 * decide which error describes what actually happened.
 *
 * The handle must stay per-call rather than module-scoped: non-browser commands
 * run concurrently with browser ones, so a shared handle would have one
 * command's cleanup cancel another's deadline. An uncancelled 60-minute timer
 * would also keep the Node event loop alive long past the command.
 */
function buildDeadline(
  timeoutMs: number,
  onExpire: () => CommandError
): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onExpire()), timeoutMs);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export async function handleExecuteCommand(message: ExecuteMessage, sendFn: SendFn): Promise<void> {
  const { commandId, type, payload } = message;
  logger.info(`Executing command ${commandId}: ${type}`);

  // Every frame goes out through safeSend. In the Electron main process the
  // send function closes over a module-level wsClient that restartWebSocket()
  // can replace mid-command, and a send that throws inside the catch block
  // below would rethrow the very error it is handling — which then escaped as
  // an unhandled rejection, because the main process does not await this
  // function. A frame that cannot be sent is logged and dropped; nothing here
  // is worth taking the process down for.
  const safeSend = (frame: Record<string, unknown>): void => {
    try {
      sendFn(frame);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn(`Dropping ${String(frame.action)} frame for command ${commandId}`, {
        error: error.message,
      });
    }
  };

  const route = ROUTES[type];
  if (!route) {
    safeSend({
      action: 'error',
      commandId,
      code: 'UNKNOWN_COMMAND',
      message: `Unknown command type: ${type}`,
    });
    return;
  }

  // Validate the untrusted payload at the trust boundary before it can drive
  // browser automation. On failure, return a structured error rather than
  // forwarding an unchecked payload to a controller.
  const validationError = validateCommandPayload(type, payload);
  if (validationError) {
    logger.warn(`Rejecting command ${commandId} (${type}): ${validationError}`);
    safeSend({
      action: 'error',
      commandId,
      code: 'INVALID_PAYLOAD',
      message: validationError,
    });
    return;
  }

  // A command reports exactly one terminal frame. The deadline below races the
  // handler rather than cancelling it, so a timed-out handler is still running
  // and will eventually try to report — that late result, and any late
  // progress, must not contradict the terminal error already sent.
  let settled = false;
  const settle = (frame: Record<string, unknown>): void => {
    if (settled) return;
    settled = true;
    safeSend(frame);
  };

  const progressCallback: ProgressCallback = (...args: unknown[]) => {
    if (settled) return;
    const [step, total, progressMessage] = args;
    safeSend({
      action: 'progress',
      commandId,
      step,
      total,
      message: progressMessage as string,
    });
  };

  // Set once the command is waiting in the browser queue, so the deadline can
  // tell "never started" from "ran too long".
  let queuedJobId: string | null = null;

  // Set when the deadline reports an overrun, i.e. the handler was already
  // running and keeps running. The continuation attached to `run` below uses it
  // to record what the handler eventually did.
  let overrunReported = false;

  const deadline = buildDeadline(route.timeoutMs, () => {
    // A job that has not started can be dropped outright: none of its code has
    // run, so nothing is half-done. That makes the terminal frame truthful.
    //
    // Without this the deadline was a lie whenever the queue was busy. Task 6
    // puts profile-init (60min) and send-message (3min) in the same
    // single-slot queue, so an interaction dispatched during a routine import
    // always exhausted its budget while still queued — the router reported
    // COMMAND_TIMEOUT and the real LinkedIn action then executed up to 57
    // minutes later. Reporting an action as failed and performing it anyway
    // re-opens, from the client side, the double-send hole the backend's
    // claim-before-send exists to prevent.
    const dropped: CommandError = new Error(
      `Command ${type} waited ${route.timeoutMs}ms for the browser queue and was dropped; it never started`
    );
    dropped.code = 'COMMAND_TIMEOUT';
    if (queuedJobId !== null && linkedInInteractionQueue.cancel(queuedJobId, dropped)) {
      return dropped;
    }
    // Already running. A Puppeteer batch cannot be safely aborted
    // mid-navigation, so this one is raced rather than cancelled: it keeps
    // running to completion in the background, and the router-level
    // serialization is what keeps the next command off the shared page.
    //
    // This outcome is AMBIGUOUS, not a failure, and must not share a code with
    // the dropped-from-queue case above. The handler is still running: it may
    // already have performed the LinkedIn action, or may complete it seconds
    // from now. Reporting it as COMMAND_TIMEOUT told the user it failed, and a
    // retry then minted a fresh idempotency key (the frontend releases the key
    // once the HTTP dispatch lands, by design, so that a deliberate re-send is
    // a new action) — so the recipient got the message twice. Naming the
    // outcome unknown is what keeps the user from retrying blindly.
    const overran: CommandError = new Error(
      `Command ${type} exceeded its ${route.timeoutMs}ms wall-clock budget and is still running. ` +
        `It may already have been performed — check LinkedIn before retrying; retrying may repeat it.`
    );
    overran.code = 'COMMAND_OUTCOME_UNKNOWN';
    overrunReported = true;
    return overran;
  });

  try {
    // Serialize here — the single choke point every command already passes
    // through — rather than inside each controller. Every browser-driving route
    // shares one singleton PuppeteerService page, so a long profile-init batch
    // running concurrently with a send-message would navigate the page out from
    // under it. Adding enqueue() calls to the controllers that lacked them
    // would just repeat the original mistake for the next route added.
    //
    // The controllers' own Direct-method enqueues were removed with this
    // change: `linkedInInteractionQueue` has concurrency 1 and is NOT
    // reentrant, so a router-level enqueue wrapping a controller-level one
    // deadlocks the command (see interactionQueue.test.js, "reentrancy").
    const invoke = (): Promise<unknown> => route.handler(payload, progressCallback);
    let run: Promise<unknown>;
    if (route.browser) {
      const job = linkedInInteractionQueue.enqueueCancellable(invoke, { type, commandId });
      queuedJobId = job.jobId;
      run = job.promise;
    } else {
      run = invoke();
    }

    // The deadline spans the queue wait as well as the handler: from the
    // backend's side the command is outstanding either way, so an unbounded
    // queue wait is the same state divergence as an unbounded handler. What
    // makes that sound is that expiry drops a still-queued job (see the
    // onExpire above) rather than reporting a failure that later comes true.
    // The late outcome has to be observed on `run` itself, not after the race.
    // buildDeadline REJECTS on expiry, so when the deadline wins, the await
    // below throws straight into the catch and any code after it is unreachable
    // — which is where this record used to live, making it dead in exactly the
    // case it exists for. Attaching here also handles a late rejection that the
    // race has already stopped observing, so it cannot surface as an unhandled
    // rejection.
    void run.then(
      () => {
        if (!overrunReported) return;
        logger.error(`Command ${commandId} completed AFTER its deadline was reported`, {
          type,
          commandId,
          timeoutMs: route.timeoutMs,
          reportedCode: 'COMMAND_OUTCOME_UNKNOWN',
        });
      },
      (lateErr: unknown) => {
        if (!overrunReported) return;
        logger.error(`Command ${commandId} failed AFTER its deadline was reported`, {
          type,
          commandId,
          error: lateErr instanceof Error ? lateErr.message : String(lateErr),
        });
      }
    );

    const result = await Promise.race([run, deadline.promise]);
    settle({
      action: 'result',
      commandId,
      data: result,
    });
  } catch (err: unknown) {
    const error = err as CommandError;
    logger.error(`Command ${commandId} failed`, { error: error.message, type });
    settle({
      action: 'error',
      commandId,
      code: error.code || 'EXECUTION_ERROR',
      message: error.message,
      details: error.details,
    });
  } finally {
    deadline.cancel();
  }
}
