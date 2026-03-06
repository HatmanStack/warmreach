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
