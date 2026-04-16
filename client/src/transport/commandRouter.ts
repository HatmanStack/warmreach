/**
 * Command router - maps execute messages from the backend to controller Direct methods.
 *
 * Each command type maps to a controller method that accepts structured payloads
 * and returns results (no Express req/res dependency).
 */

import { logger } from '#utils/logger.js';
import { SearchController } from '../domains/search/controllers/searchController.js';
import { LinkedInInteractionController } from '../domains/linkedin/controllers/linkedinInteractionController.js';
import { ProfileInitController } from '../domains/profile/controllers/profileInitController.js';

type ProgressCallback = (...args: unknown[]) => void;

type CommandPayload = Record<string, any>;

interface CommandRoute {
  handler: (payload: CommandPayload, onProgress: ProgressCallback) => Promise<unknown>;
}

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
 */
const ROUTES: Record<string, CommandRoute> = {
  'linkedin:search': {
    handler: (payload, onProgress) => searchController.performSearchDirect(payload, onProgress),
  },
  'linkedin:send-message': {
    handler: (payload, onProgress) => interactionController.sendMessageDirect(payload, onProgress),
  },
  'linkedin:add-connection': {
    handler: (payload, onProgress) =>
      interactionController.addConnectionDirect(payload, onProgress),
  },
  'linkedin:profile-init': {
    handler: (payload, onProgress) => profileInitController.initializeDirect(payload, onProgress),
  },
};

export async function handleExecuteCommand(message: ExecuteMessage, sendFn: SendFn): Promise<void> {
  const { commandId, type, payload } = message;
  logger.info(`Executing command ${commandId}: ${type}`);

  const route = ROUTES[type];
  if (!route) {
    sendFn({
      action: 'error',
      commandId,
      code: 'UNKNOWN_COMMAND',
      message: `Unknown command type: ${type}`,
    });
    return;
  }

  const progressCallback: ProgressCallback = (...args: unknown[]) => {
    const [step, total, progressMessage] = args;
    sendFn({
      action: 'progress',
      commandId,
      step,
      total,
      message: progressMessage as string,
    });
  };

  try {
    const result = await route.handler(payload, progressCallback);
    sendFn({
      action: 'result',
      commandId,
      data: result,
    });
  } catch (err: unknown) {
    const error = err as CommandError;
    logger.error(`Command ${commandId} failed`, { error: error.message, type });
    sendFn({
      action: 'error',
      commandId,
      code: error.code || 'EXECUTION_ERROR',
      message: error.message,
      details: error.details,
    });
  }
}
