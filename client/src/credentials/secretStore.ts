/**
 * Sealed-value storage for the Electron client.
 *
 * Wraps an electron-store instance so that individual values are encrypted with
 * Electron's `safeStorage` (OS keyring: Keychain, DPAPI, libsecret/kwallet)
 * before they touch disk. The store file itself is plain JSON — encryption is
 * per-value and keyed by the OS, never by a constant compiled into this
 * publicly mirrored repository.
 *
 * Policy: when no keyring is available, writes are REFUSED. Falling back to
 * plaintext is the exact failure being fixed, so a "graceful degradation" would
 * only reintroduce it quietly.
 */

import { logger } from '#utils/logger.js';

/** Storage format version for a sealed record. */
export const SEALED_VERSION = 2;

export interface ElectronStoreInterface {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

/** The slice of Electron's `safeStorage` this module uses. */
export interface SafeStorageInterface {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Sealed on-disk shape: one opaque blob, so the value is fully hidden. */
export interface SealedRecord {
  v: number;
  blob: string;
}

/**
 * Thrown when a secret cannot be sealed because the OS provides no keyring.
 *
 * On Linux this usually means no libsecret provider (gnome-keyring / kwallet)
 * is installed or the session is headless.
 */
export class EncryptionUnavailableError extends Error {
  constructor(what = 'this value') {
    super(
      `Cannot store ${what}: no OS keyring is available to encrypt it. ` +
        'On Linux, install and unlock gnome-keyring or kwallet, then try again.'
    );
    this.name = 'EncryptionUnavailableError';
  }
}

export function isSealed(value: unknown): value is SealedRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as SealedRecord).v === SEALED_VERSION &&
    typeof (value as SealedRecord).blob === 'string'
  );
}

/** Seal a JSON-serialisable value into a storable record. */
export function seal(safeStorage: SafeStorageInterface, value: unknown): SealedRecord {
  const blob = safeStorage.encryptString(JSON.stringify(value)).toString('base64');
  return { v: SEALED_VERSION, blob };
}

/** Unseal a record, or return null if it cannot be decrypted. */
export function unseal<T>(safeStorage: SafeStorageInterface, record: SealedRecord): T | null {
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(record.blob, 'base64'))) as T;
  } catch (err) {
    // A keyring that changed underneath us (reinstalled OS, new user account)
    // makes the blob permanently undecryptable. Report rather than crash; the
    // user recovers by re-entering the value.
    logger.error('Failed to decrypt a sealed value', { error: (err as Error).message });
    return null;
  }
}

export class SecretStore {
  private _store: ElectronStoreInterface;
  private _safeStorage: SafeStorageInterface;
  private _warnedKeys = new Set<string>();

  constructor(store: ElectronStoreInterface, safeStorage: SafeStorageInterface) {
    this._store = store;
    this._safeStorage = safeStorage;
  }

  isEncryptionAvailable(): boolean {
    return this._safeStorage.isEncryptionAvailable();
  }

  /**
   * Read a secret, transparently upgrading a legacy plaintext value.
   *
   * A legacy value that cannot be sealed is still returned — deleting a user's
   * only copy would strand them — but it warns once per key.
   */
  getSecret<T>(key: string): T | null {
    const raw = this._store.get(key);
    if (raw === undefined || raw === null) return null;

    if (isSealed(raw)) return unseal<T>(this._safeStorage, raw);

    if (this._safeStorage.isEncryptionAvailable()) {
      this._store.set(key, seal(this._safeStorage, raw));
      logger.info('Migrated a stored secret to OS-encrypted storage', { key });
    } else if (!this._warnedKeys.has(key)) {
      this._warnedKeys.add(key);
      logger.warn(
        `Stored secret "${key}" is UNENCRYPTED because no OS keyring is available. ` +
          'Install and unlock gnome-keyring or kwallet to secure it.'
      );
    }
    return raw as T;
  }

  /**
   * Seal and store a secret.
   *
   * @throws {EncryptionUnavailableError} when no OS keyring exists.
   */
  setSecret(key: string, value: unknown, label = `"${key}"`): void {
    if (!this._safeStorage.isEncryptionAvailable()) {
      logger.error('Refusing to store a secret: no OS keyring available', { key });
      throw new EncryptionUnavailableError(label);
    }
    this._store.set(key, seal(this._safeStorage, value));
  }

  deleteSecret(key: string): void {
    this._store.delete(key);
  }

  /** Whether a non-empty value is present, without decrypting it. */
  hasSecret(key: string): boolean {
    const raw = this._store.get(key);
    if (isSealed(raw)) return raw.blob.length > 0;
    return raw !== undefined && raw !== null && raw !== '';
  }
}
