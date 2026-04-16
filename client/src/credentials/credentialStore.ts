/**
 * LinkedIn credential store for Electron.
 *
 * Stores LinkedIn credentials locally in electron-store (encrypted at rest).
 * Credentials never leave the user's machine.
 */

import { logger } from '#utils/logger.js';

const CREDENTIALS_KEY = 'linkedin_credentials';

interface ElectronStoreInterface {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

interface LinkedInCredentials {
  email: string;
  password: string;
}

export class CredentialStore {
  private _store: ElectronStoreInterface;

  constructor(store: ElectronStoreInterface) {
    this._store = store;
  }

  getCredentials(): LinkedInCredentials | null {
    const creds = this._store.get(CREDENTIALS_KEY) as Partial<LinkedInCredentials> | undefined;
    if (!creds?.email || !creds?.password) {
      return null;
    }
    return { email: creds.email, password: creds.password };
  }

  setCredentials(email: string, password: string): void {
    this._store.set(CREDENTIALS_KEY, { email, password });
    logger.info('LinkedIn credentials stored');
  }

  clearCredentials(): void {
    this._store.delete(CREDENTIALS_KEY);
    logger.info('LinkedIn credentials cleared');
  }

  hasCredentials(): boolean {
    return !!(this._store.get(CREDENTIALS_KEY) as Partial<LinkedInCredentials> | undefined)?.email;
  }
}
