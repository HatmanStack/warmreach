import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { logger } from '#utils/logger.js';
import {
  openConfigStore,
  STORE_NAME,
  LEGACY_STORE_NAME,
  LEGACY_ENCRYPTION_KEY,
  type StoreLike,
} from './configStore.js';
import { isSealed, seal, unseal, type SafeStorageInterface } from './secretStore.js';

const TOKEN = 'eyJhbGciOi.fake.token';
const REFRESH = 'refresh-token-value';
const CREDS = { email: 'a@b.co', password: 'hunter2' };

function makeSafeStorage(available = true): SafeStorageInterface {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('bad ciphertext');
      return s.slice(4);
    },
  };
}

/** electron-store stand-in with dot-path get/set, matching the real one. */
function makeStore(initial: Record<string, unknown> = {}): StoreLike {
  let data: Record<string, unknown> = structuredClone(initial);
  const walk = (path: string[], create: boolean): Record<string, unknown> | undefined => {
    let node: Record<string, unknown> = data;
    for (const part of path) {
      if (typeof node[part] !== 'object' || node[part] === null) {
        if (!create) return undefined;
        node[part] = {};
      }
      node = node[part] as Record<string, unknown>;
    }
    return node;
  };
  return {
    get(key: string) {
      const parts = key.split('.');
      const leaf = parts.pop() as string;
      return walk(parts, false)?.[leaf];
    },
    set(key: string, value: unknown) {
      const parts = key.split('.');
      const leaf = parts.pop() as string;
      (walk(parts, true) as Record<string, unknown>)[leaf] = value;
    },
    delete(key: string) {
      const parts = key.split('.');
      const leaf = parts.pop() as string;
      const node = walk(parts, false);
      if (node) delete node[leaf];
    },
    get store() {
      return data;
    },
    set store(v: Record<string, unknown>) {
      data = v;
    },
  } as StoreLike;
}

/** Wires createStore so the legacy and new files are distinct instances. */
function makeFactory(legacy: StoreLike, fresh: StoreLike) {
  const seen: Array<{ name: string; encryptionKey?: string }> = [];
  const createStore = (options: { name: string; encryptionKey?: string }) => {
    seen.push(options);
    return options.name === LEGACY_STORE_NAME ? legacy : fresh;
  };
  return { createStore, seen };
}

describe('openConfigStore', () => {
  beforeEach(() => vi.clearAllMocks());

  it('migrates legacy data and seals only the secrets', () => {
    const legacy = makeStore({
      wsUrl: 'wss://example.test/prod',
      linkedin_credentials: CREDS,
      auth: { accessToken: TOKEN, refreshToken: REFRESH, region: 'us-east-1' },
    });
    const fresh = makeStore();
    const safeStorage = makeSafeStorage();
    const { createStore } = makeFactory(legacy, fresh);
    const deleteLegacyFile = vi.fn();

    const result = openConfigStore({ createStore, safeStorage, deleteLegacyFile });

    expect(result.migrated).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.store).toBe(fresh);

    // Non-secrets stay readable in the clear.
    expect(fresh.get('wsUrl')).toBe('wss://example.test/prod');
    expect(fresh.get('auth.region')).toBe('us-east-1');

    // Secrets are sealed, and recoverable.
    for (const key of ['linkedin_credentials', 'auth.accessToken', 'auth.refreshToken']) {
      expect(isSealed(fresh.get(key))).toBe(true);
    }
    expect(unseal(safeStorage, fresh.get('auth.accessToken') as never)).toBe(TOKEN);
    expect(unseal(safeStorage, fresh.get('linkedin_credentials') as never)).toEqual(CREDS);

    // Nothing secret survives as plaintext anywhere in the new file.
    const dump = JSON.stringify(fresh.store);
    expect(dump).not.toContain(CREDS.password);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(REFRESH);

    expect(deleteLegacyFile).toHaveBeenCalledOnce();
  });

  it('reads the legacy file with the old key, and the new one without', () => {
    const { createStore, seen } = makeFactory(makeStore({ wsUrl: 'x' }), makeStore());

    openConfigStore({ createStore, safeStorage: makeSafeStorage() });

    expect(seen).toEqual([
      { name: STORE_NAME },
      { name: LEGACY_STORE_NAME, encryptionKey: LEGACY_ENCRYPTION_KEY },
    ]);
  });

  it('refuses to migrate without a keyring, keeping the legacy store', () => {
    const legacy = makeStore({ wsUrl: 'wss://example.test', linkedin_credentials: CREDS });
    const fresh = makeStore();
    const { createStore } = makeFactory(legacy, fresh);
    const deleteLegacyFile = vi.fn();

    const result = openConfigStore({
      createStore,
      safeStorage: makeSafeStorage(false),
      deleteLegacyFile,
    });

    // Rewriting secrets into a plain file would be worse than the bug we are
    // fixing, so the install stays exactly where it was.
    expect(result.degraded).toBe(true);
    expect(result.migrated).toBe(false);
    expect(result.store).toBe(legacy);
    expect(fresh.store).toEqual({});
    expect(deleteLegacyFile).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('static key'));
  });

  it('never writes a plaintext secret to the new file, even transiently', () => {
    // electron-store persists on every set(), so a copy-then-seal migration
    // would land the plaintext on disk and only afterwards overwrite it — and a
    // crash in between would leave it there for good, with the "already
    // migrated" guard ensuring no retry. Secrets must be sealed before the
    // single write.
    const legacy = makeStore({
      wsUrl: 'wss://example.test',
      linkedin_credentials: CREDS,
      auth: { accessToken: TOKEN, refreshToken: REFRESH },
    });
    const fresh = makeStore();
    const writes: string[] = [];
    const recording: StoreLike = {
      get: (k) => fresh.get(k),
      set: (k, v) => {
        fresh.set(k, v);
        writes.push(JSON.stringify(fresh.store));
      },
      delete: (k) => fresh.delete(k),
      get store() {
        return fresh.store;
      },
      set store(v: Record<string, unknown>) {
        fresh.store = v;
        writes.push(JSON.stringify(fresh.store));
      },
    } as StoreLike;
    const { createStore } = makeFactory(legacy, recording);

    openConfigStore({ createStore, safeStorage: makeSafeStorage() });

    expect(writes.length).toBeGreaterThan(0);
    for (const snapshot of writes) {
      expect(snapshot).not.toContain(CREDS.password);
      expect(snapshot).not.toContain(TOKEN);
      expect(snapshot).not.toContain(REFRESH);
    }
    // One bulk write, not a per-key stream.
    expect(writes).toHaveLength(1);
  });

  it('does not double-seal a record an earlier version already sealed', () => {
    const safeStorage = makeSafeStorage();
    const alreadySealed = seal(safeStorage, CREDS);
    const legacy = makeStore({ linkedin_credentials: alreadySealed, wsUrl: 'x' });
    const fresh = makeStore();
    const { createStore } = makeFactory(legacy, fresh);

    openConfigStore({ createStore, safeStorage });

    // One unseal must yield the credentials, not another sealed record.
    expect(unseal(safeStorage, fresh.get('linkedin_credentials') as never)).toEqual(CREDS);
  });

  it('leaves an already-migrated store alone', () => {
    const fresh = makeStore({ wsUrl: 'already-here' });
    const legacy = makeStore({ wsUrl: 'stale-legacy' });
    const { createStore } = makeFactory(legacy, fresh);
    const deleteLegacyFile = vi.fn();

    const result = openConfigStore({
      createStore,
      safeStorage: makeSafeStorage(),
      deleteLegacyFile,
    });

    expect(result.migrated).toBe(false);
    expect(fresh.get('wsUrl')).toBe('already-here');
    expect(deleteLegacyFile).not.toHaveBeenCalled();
  });

  it('starts clean on a fresh install', () => {
    const { createStore } = makeFactory(makeStore(), makeStore());

    const result = openConfigStore({ createStore, safeStorage: makeSafeStorage() });

    expect(result).toMatchObject({ migrated: false, degraded: false });
  });

  it('does not block startup when the legacy file is unreadable', () => {
    const fresh = makeStore();
    const createStore = (options: { name: string }) => {
      if (options.name === LEGACY_STORE_NAME) throw new Error('corrupt or wrong key');
      return fresh;
    };

    const result = openConfigStore({ createStore, safeStorage: makeSafeStorage() });

    expect(result.store).toBe(fresh);
    expect(result.migrated).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('legacy config store'),
      expect.anything()
    );
  });

  it('keeps migrated data when the legacy file cannot be deleted', () => {
    const legacy = makeStore({ wsUrl: 'wss://example.test', auth: { accessToken: TOKEN } });
    const fresh = makeStore();
    const { createStore } = makeFactory(legacy, fresh);

    const result = openConfigStore({
      createStore,
      safeStorage: makeSafeStorage(),
      deleteLegacyFile: () => {
        throw new Error('EPERM');
      },
    });

    // A leftover file is untidy, not dangerous — the migration still counts.
    expect(result.migrated).toBe(true);
    expect(fresh.get('wsUrl')).toBe('wss://example.test');
  });
});
