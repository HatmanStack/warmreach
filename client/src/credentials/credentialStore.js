/**
 * LinkedIn credential store for Electron.
 *
 * Stores LinkedIn credentials locally in electron-store (encrypted at rest).
 * Credentials never leave the user's machine.
 */

import { logger } from '#utils/logger.js';

const CREDENTIALS_KEY = 'linkedin_credentials';

export class CredentialStore {
  constructor(store) {
    this._store = store;
  }

  /**
   * Get stored LinkedIn credentials.
   * @returns {{ email: string, password: string } | null}
   */
  getCredentials() {
    const creds = this._store.get(CREDENTIALS_KEY);
    if (!creds?.email || !creds?.password) {
      return null;
    }
    return { email: creds.email, password: creds.password };
  }

  /**
   * Store LinkedIn credentials.
   */
  setCredentials(email, password) {
    this._store.set(CREDENTIALS_KEY, { email, password });
    logger.info('LinkedIn credentials stored');
  }

  /**
   * Clear stored credentials.
   */
  clearCredentials() {
    this._store.delete(CREDENTIALS_KEY);
    logger.info('LinkedIn credentials cleared');
  }

  /**
   * Check if credentials are stored.
   */
  hasCredentials() {
    return !!this._store.get(CREDENTIALS_KEY)?.email;
  }
}
