/**
 * LinkedIn credential store for Electron.
 *
 * Credentials are encrypted at rest with Electron's `safeStorage`, which is
 * backed by the OS keychain (Keychain on macOS, DPAPI on Windows, and
 * libsecret/kwallet on Linux). Credentials never leave the user's machine.
 *
 * Sealing is delegated to {@link SecretStore}; see that module for the
 * refuse-rather-than-downgrade policy and the legacy migration path.
 *
 * Note that `safeStorage` is unrelated to the libsodium Sealbox in
 * `shared/utils/crypto.ts`. That one decrypts credentials arriving *in a
 * command payload* over the wire; this one protects the copy sitting *on disk*.
 * The two are alternative sources of the same credentials, not layers.
 */

import {
  SecretStore,
  EncryptionUnavailableError,
  type ElectronStoreInterface,
  type SafeStorageInterface,
} from './secretStore.js';

const CREDENTIALS_KEY = 'linkedin_credentials';

interface LinkedInCredentials {
  email: string;
  password: string;
}

export type { SafeStorageInterface };

/**
 * Thrown when credentials cannot be sealed because the OS provides no keyring.
 *
 * Storing them anyway would mean writing a LinkedIn password to disk in the
 * clear, so this refuses instead.
 */
export class CredentialEncryptionUnavailableError extends EncryptionUnavailableError {
  constructor() {
    super('LinkedIn credentials');
    this.name = 'CredentialEncryptionUnavailableError';
  }
}

export class CredentialStore {
  private _secrets: SecretStore;

  constructor(store: ElectronStoreInterface, safeStorage: SafeStorageInterface) {
    this._secrets = new SecretStore(store, safeStorage);
  }

  /** Whether credentials can be stored on this machine. */
  isEncryptionAvailable(): boolean {
    return this._secrets.isEncryptionAvailable();
  }

  getCredentials(): LinkedInCredentials | null {
    const creds = this._secrets.getSecret<Partial<LinkedInCredentials>>(CREDENTIALS_KEY);
    if (!creds?.email || !creds?.password) return null;
    return { email: creds.email, password: creds.password };
  }

  /**
   * Seal and store credentials.
   *
   * @throws {CredentialEncryptionUnavailableError} when no OS keyring exists.
   */
  setCredentials(email: string, password: string): void {
    if (!this._secrets.isEncryptionAvailable()) {
      throw new CredentialEncryptionUnavailableError();
    }
    this._secrets.setSecret(CREDENTIALS_KEY, { email, password }, 'LinkedIn credentials');
  }

  clearCredentials(): void {
    this._secrets.deleteSecret(CREDENTIALS_KEY);
  }

  hasCredentials(): boolean {
    return this._secrets.hasSecret(CREDENTIALS_KEY);
  }
}
