import fs from 'fs/promises';
import path from 'path';
import { logger } from '#utils/logger.js';

const SESSIONS_FILE = path.join(process.cwd(), 'data', 'heal-restore-sessions.json');

interface SessionData {
  status: string;
  timestamp?: string;
  autoApprove?: boolean;
}

async function loadSessions(): Promise<Record<string, SessionData>> {
  try {
    const data = await fs.readFile(SESSIONS_FILE, 'utf8');
    return JSON.parse(data) as Record<string, SessionData>;
  } catch {
    return {};
  }
}

async function saveSessions(sessions: Record<string, SessionData>): Promise<void> {
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

export async function authorizeHealAndRestore(
  sessionId: string,
  autoApprove = false
): Promise<boolean> {
  const sessions = await loadSessions();
  const session = sessions[sessionId];

  if (session && session.status === 'pending') {
    sessions[sessionId]!.status = 'authorized';
    sessions[sessionId]!.autoApprove = autoApprove;
    await saveSessions(sessions);
    logger.info(`Heal and restore authorized for session: ${sessionId}`, { autoApprove });
    return true;
  }

  return false;
}

export async function cancelHealAndRestore(sessionId: string): Promise<boolean> {
  const sessions = await loadSessions();
  const session = sessions[sessionId];

  if (session && session.status === 'pending') {
    sessions[sessionId]!.status = 'cancelled';
    await saveSessions(sessions);
    logger.info(`Heal and restore cancelled for session: ${sessionId}`);
    return true;
  }

  return false;
}

export async function getPendingAuthorizations(): Promise<
  { sessionId: string; timestamp?: string }[]
> {
  const sessions = await loadSessions();
  return Object.entries(sessions)
    .filter(([_key, data]) => data.status === 'pending')
    .map(([sessionId, data]) => ({
      sessionId,
      timestamp: data.timestamp,
    }));
}
