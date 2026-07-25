import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { logger } from '#utils/logger.js';
import {
  CredentialStore,
  CredentialEncryptionUnavailableError,
  type SafeStorageInterface,
} from './credentialStore.js';

const KEY = 'linkedin_credentials';
const EMAIL = 'someone@example.com';
const PASSWORD = 'correct horse battery staple';

/** In-memory stand-in for electron-store. */
function makeStore(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: (k: string) => data[k],
    set: vi.fn((k: string, v: unknown) => {
      data[k] = v;
    }),
    delete: vi.fn((k: string) => {
      delete data[k];
    }),
  };
}

/**
 * Reversible stand-in for Electron's safeStorage. The "ciphertext" is a marked,
 * byte-shifted buffer — enough to prove the plaintext is not what lands on
 * disk, without pretending to be real crypto.
 */
function makeSafeStorage(available = true): SafeStorageInterface & { available: boolean } {
  const impl = {
    available,
    isEncryptionAvailable: () => impl.available,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('bad ciphertext');
      return s.slice(4);
    },
  };
  return impl;
}

describe('CredentialStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sealing', () => {
    it('never writes the password in the clear', () => {
      const store = makeStore();
      const safeStorage = makeSafeStorage();
      new CredentialStore(store, safeStorage).setCredentials(EMAIL, PASSWORD);

      const written = JSON.stringify(store.data[KEY]);
      expect(written).not.toContain(PASSWORD);
      // The email is inside the same blob, so it is hidden too.
      expect(written).not.toContain(EMAIL);
      expect(store.data[KEY]).toMatchObject({ v: 2 });
    });

    it('round-trips through the sealed format', () => {
      const sut = new CredentialStore(makeStore(), makeSafeStorage());
      sut.setCredentials(EMAIL, PASSWORD);

      expect(sut.getCredentials()).toEqual({ email: EMAIL, password: PASSWORD });
    });

    it('reports having credentials once sealed', () => {
      const sut = new CredentialStore(makeStore(), makeSafeStorage());
      expect(sut.hasCredentials()).toBe(false);

      sut.setCredentials(EMAIL, PASSWORD);
      expect(sut.hasCredentials()).toBe(true);
    });
  });

  describe('when no OS keyring is available', () => {
    it('refuses to store rather than writing plaintext', () => {
      const store = makeStore();
      const sut = new CredentialStore(store, makeSafeStorage(false));

      expect(() => sut.setCredentials(EMAIL, PASSWORD)).toThrow(
        CredentialEncryptionUnavailableError
      );
      // The critical assertion: nothing reached disk.
      expect(store.set).not.toHaveBeenCalled();
      expect(store.data[KEY]).toBeUndefined();
    });

    it('explains how to fix it', () => {
      const sut = new CredentialStore(makeStore(), makeSafeStorage(false));

      expect(() => sut.setCredentials(EMAIL, PASSWORD)).toThrow(/gnome-keyring|kwallet/);
    });

    it('exposes availability so callers can warn ahead of time', () => {
      expect(new CredentialStore(makeStore(), makeSafeStorage(false)).isEncryptionAvailable()).toBe(
        false
      );
    });
  });

  describe('legacy plaintext migration', () => {
    it('re-seals an existing plaintext record on read', () => {
      const store = makeStore({ [KEY]: { email: EMAIL, password: PASSWORD } });
      const sut = new CredentialStore(store, makeSafeStorage());

      expect(sut.getCredentials()).toEqual({ email: EMAIL, password: PASSWORD });

      // The plaintext is gone from disk, replaced by a sealed record.
      expect(store.data[KEY]).toMatchObject({ v: 2 });
      expect(JSON.stringify(store.data[KEY])).not.toContain(PASSWORD);
    });

    it('keeps working but warns when it cannot migrate', () => {
      const store = makeStore({ [KEY]: { email: EMAIL, password: PASSWORD } });
      const sut = new CredentialStore(store, makeSafeStorage(false));

      // Deleting the user's only copy would strand them, so reads still work.
      expect(sut.getCredentials()).toEqual({ email: EMAIL, password: PASSWORD });
      expect(store.set).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('UNENCRYPTED'));
    });

    it('warns once, not on every read', () => {
      const store = makeStore({ [KEY]: { email: EMAIL, password: PASSWORD } });
      const sut = new CredentialStore(store, makeSafeStorage(false));

      sut.getCredentials();
      sut.getCredentials();
      sut.getCredentials();

      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('recognises a legacy record in hasCredentials', () => {
      const store = makeStore({ [KEY]: { email: EMAIL, password: PASSWORD } });
      expect(new CredentialStore(store, makeSafeStorage()).hasCredentials()).toBe(true);
    });
  });

  describe('degraded reads', () => {
    it('returns null instead of throwing when the blob will not decrypt', () => {
      // A reinstalled OS or new user account leaves an undecryptable blob.
      const store = makeStore({ [KEY]: { v: 2, blob: Buffer.from('garbage').toString('base64') } });
      const sut = new CredentialStore(store, makeSafeStorage());

      expect(sut.getCredentials()).toBeNull();
      expect(logger.error).toHaveBeenCalled();
    });

    it('returns null for an empty store', () => {
      expect(new CredentialStore(makeStore(), makeSafeStorage()).getCredentials()).toBeNull();
    });

    it('returns null for a partial legacy record', () => {
      const store = makeStore({ [KEY]: { email: EMAIL } });
      expect(new CredentialStore(store, makeSafeStorage()).getCredentials()).toBeNull();
    });
  });

  it('clears credentials', () => {
    const store = makeStore();
    const sut = new CredentialStore(store, makeSafeStorage());
    sut.setCredentials(EMAIL, PASSWORD);

    sut.clearCredentials();

    expect(store.delete).toHaveBeenCalledWith(KEY);
    expect(sut.hasCredentials()).toBe(false);
  });
});
