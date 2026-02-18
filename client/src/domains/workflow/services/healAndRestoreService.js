import fs from 'fs/promises';
import path from 'path';
import { logger } from '#utils/logger.js';

const SESSIONS_FILE = path.join(process.cwd(), 'data', 'heal-restore-sessions.json');

// Load sessions from file
async function loadSessions() {
  try {
    const data = await fs.readFile(SESSIONS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

// Save sessions to file
async function saveSessions(sessions) {
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// Function to wait for heal and restore authorization
export async function waitForHealAndRestoreAuthorization(sessionId) {
  // Save session to file
  const sessions = await loadSessions();
  sessions[sessionId] = {
    timestamp: Date.now(),
    status: 'pending',
  };
  await saveSessions(sessions);
  logger.info(`Waiting for heal and restore authorization for session: ${sessionId}`);

  // Poll for authorization
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(async () => {
      // Clean up on timeout
      const sessions = await loadSessions();
      delete sessions[sessionId];
      await saveSessions(sessions);
      reject(new Error('Heal and restore authorization timeout'));
    }, 3600000); // 60 minute timeout

    const checkAuthorization = async () => {
      const sessions = await loadSessions();
      const session = sessions[sessionId];

      if (!session) {
        // Session was deleted (authorized or timed out)
        clearTimeout(timeout);
        resolve();
        return;
      }

      if (session.status === 'authorized') {
        // Clean up authorized session
        delete sessions[sessionId];
        await saveSessions(sessions);
        clearTimeout(timeout);
        resolve();
        return;
      }

      if (session.status === 'cancelled') {
        // On cancel, clean up and reject so caller can abort workflow
        delete sessions[sessionId];
        await saveSessions(sessions);
        clearTimeout(timeout);
        reject(new Error('Heal and restore cancelled'));
        return;
      }

      // Check again in 1 second
      setTimeout(checkAuthorization, 1000);
    };

    checkAuthorization();
  });
}

// Function to authorize heal and restore (called by API endpoint)
export async function authorizeHealAndRestore(sessionId, autoApprove = false) {
  const sessions = await loadSessions();
  const session = sessions[sessionId];

  if (session && session.status === 'pending') {
    sessions[sessionId].status = 'authorized';
    sessions[sessionId].autoApprove = autoApprove;
    await saveSessions(sessions);
    logger.info(`Heal and restore authorized for session: ${sessionId}`, { autoApprove });
    return true;
  }

  return false;
}

// Function to cancel heal and restore (called by API endpoint)
export async function cancelHealAndRestore(sessionId) {
  const sessions = await loadSessions();
  const session = sessions[sessionId];

  if (session && session.status === 'pending') {
    sessions[sessionId].status = 'cancelled';
    await saveSessions(sessions);
    logger.info(`Heal and restore cancelled for session: ${sessionId}`);
    return true;
  }

  return false;
}

// Function to check for pending authorizations (called by API endpoint)
export async function getPendingAuthorizations() {
  const sessions = await loadSessions();
  return Object.entries(sessions)
    .filter(([_, data]) => data.status === 'pending')
    .map(([sessionId, data]) => ({
      sessionId,
      timestamp: data.timestamp,
    }));
}
