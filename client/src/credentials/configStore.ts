/**
 * Config store construction and the one-time migration off the static key.
 *
 * The client used to open electron-store with
 * `{ encryptionKey: 'warmreach-local-v1' }` — a constant in a publicly mirrored
 * repository, so it obfuscated config.json and secured nothing. Simply dropping
 * the option would leave every existing install unable to read its own file,
 * silently resetting the WebSocket URL and signing the user out.
 *
 * So this migrates instead: read the legacy encrypted file once, seal the
 * values that are actually secret with `safeStorage`, write them to a new
 * plain-JSON file, and only then discard the old one.
 *
 * The migration is skipped entirely when no OS keyring is available. Writing a
 * plain file in that case would take secrets from "weakly obfuscated" to
 * "plaintext on disk" — worse than the bug being fixed. Such installs stay on
 * the legacy file, and `SecretStore` refuses new secret writes.
 */

import { logger } from '#utils/logger.js';
import { seal, isSealed, type SafeStorageInterface } from './secretStore.js';

/** electron-store's default file name, i.e. the legacy encrypted config.json. */
export const LEGACY_STORE_NAME = 'config';

/** The post-migration file: plain JSON, individual secrets sealed. */
export const STORE_NAME = 'settings';

/** The key that used to "encrypt" the store. Kept only to read legacy files. */
export const LEGACY_ENCRYPTION_KEY = 'warmreach-local-v1';

/** Keys whose values must be sealed rather than written in the clear. */
export const SECRET_KEYS = ['linkedin_credentials', 'auth.accessToken', 'auth.refreshToken'];

export interface StoreLike {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  /** Bulk accessor; assigning replaces the whole file in a single write. */
  store: Record<string, unknown>;
}

export interface OpenConfigStoreDeps {
  /** Constructs an electron-store (injected so this is testable). */
  createStore: (options: { name: string; encryptionKey?: string }) => StoreLike;
  safeStorage: SafeStorageInterface;
  /** Removes the legacy file once its contents are safely rewritten. */
  deleteLegacyFile?: () => void;
}

export interface OpenConfigStoreResult {
  store: StoreLike;
  /** True when this call performed the legacy migration. */
  migrated: boolean;
  /**
   * True when the install is stuck on the legacy encrypted file because no OS
   * keyring is available. Secrets are no worse off than before, but no new
   * ones can be stored.
   */
  degraded: boolean;
}

function isEmpty(data: Record<string, unknown> | undefined): boolean {
  return !data || Object.keys(data).length === 0;
}

/** Assign a dot-path (`auth.accessToken`) within a plain object, creating gaps. */
function setPath(target: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  const leaf = parts.pop() as string;
  let node = target;
  for (const part of parts) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[leaf] = value;
}

/**
 * Open the config store, migrating off the static encryption key if needed.
 */
export function openConfigStore(deps: OpenConfigStoreDeps): OpenConfigStoreResult {
  const { createStore, safeStorage, deleteLegacyFile } = deps;

  const store = createStore({ name: STORE_NAME });

  // Already migrated (or a fresh install that has since been written to).
  if (!isEmpty(store.store)) {
    return { store, migrated: false, degraded: false };
  }

  let legacyData: Record<string, unknown> | undefined;
  let legacy: StoreLike | undefined;
  try {
    legacy = createStore({ name: LEGACY_STORE_NAME, encryptionKey: LEGACY_ENCRYPTION_KEY });
    legacyData = legacy.store;
  } catch (err) {
    // An unreadable legacy file is not fatal — treat it as a fresh install
    // rather than blocking startup.
    logger.warn('Could not read the legacy config store; starting fresh', {
      error: (err as Error).message,
    });
    return { store, migrated: false, degraded: false };
  }

  if (isEmpty(legacyData)) {
    return { store, migrated: false, degraded: false };
  }

  if (!safeStorage.isEncryptionAvailable()) {
    // Staying put keeps secrets exactly as safe as they were. Rewriting them
    // into a plain file would actively make things worse.
    logger.warn(
      'No OS keyring available, so the config store cannot be migrated off its ' +
        'static key. Install and unlock gnome-keyring or kwallet to secure stored secrets.'
    );
    return { store: legacy as StoreLike, migrated: false, degraded: true };
  }

  // Build the migrated tree in memory and write it exactly once.
  //
  // Do NOT copy first and seal afterwards: electron-store persists on every
  // `set()`, so that sequence would write the plaintext secrets into the new
  // *unencrypted* file and only then overwrite them. The plaintext would touch
  // disk on every successful migration, and a crash between the two passes
  // would leave it there permanently — the `isEmpty` guard above would treat
  // the partial file as already migrated and never retry. Sealing before the
  // single write means no plaintext secret is ever written to the new file.
  const migrated = structuredClone(legacyData) as Record<string, unknown>;

  // SECRET_KEYS are dot-paths; electron-store nests `auth.accessToken` under an
  // `auth` object, so they are not top-level entries.
  for (const key of SECRET_KEYS) {
    const value = (legacy as StoreLike).get(key);
    if (value === undefined || value === null) continue;
    // A record sealed by an earlier version is already safe; re-sealing it
    // would nest one blob inside another and make it unreadable.
    if (isSealed(value)) continue;
    setPath(migrated, key, seal(safeStorage, value));
  }

  store.store = migrated;

  // Only now is it safe to drop the old file.
  try {
    deleteLegacyFile?.();
  } catch (err) {
    // The data is already safely rewritten; a leftover file is untidy, not
    // dangerous, and must not take startup down.
    logger.warn('Migrated config store but could not remove the legacy file', {
      error: (err as Error).message,
    });
  }

  logger.info('Migrated config store off its static encryption key', {
    keys: Object.keys(legacyData as Record<string, unknown>).length,
  });
  return { store, migrated: true, degraded: false };
}
