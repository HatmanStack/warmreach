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

const searchController = new SearchController();
const interactionController = new LinkedInInteractionController();
const profileInitController = new ProfileInitController();

/**
 * Route map: command type → { controller, method }
 * Direct methods accept (payload, progressCallback) and return result objects.
 */
const ROUTES = {
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

/**
 * Handle an execute command from the WebSocket backend.
 *
 * @param {object} message - { action: 'execute', commandId, type, payload }
 * @param {function} sendFn - function to send WS messages back
 */
export async function handleExecuteCommand(message, sendFn) {
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

  const progressCallback = (step, total, progressMessage) => {
    sendFn({
      action: 'progress',
      commandId,
      step,
      total,
      message: progressMessage,
    });
  };

  try {
    const result = await route.handler(payload, progressCallback);
    sendFn({
      action: 'result',
      commandId,
      data: result,
    });
  } catch (err) {
    logger.error(`Command ${commandId} failed`, { error: err.message, type });
    sendFn({
      action: 'error',
      commandId,
      code: err.code || 'EXECUTION_ERROR',
      message: err.message,
      details: err.details,
    });
  }
}
