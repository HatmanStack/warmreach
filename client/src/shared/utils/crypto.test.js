import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

describe('crypto utilities', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('decryptSealboxB64Tag', () => {
    it('should reject non-string input', async () => {
      const { decryptSealboxB64Tag } = await import('./crypto.js');
      const result = await decryptSealboxB64Tag(123);
      expect(result).toBeNull();
    });

    it('should reject input without correct prefix', async () => {
      const { decryptSealboxB64Tag } = await import('./crypto.js');
      const result = await decryptSealboxB64Tag('wrong-prefix:data');
      expect(result).toBeNull();
    });

    it('should reject empty string', async () => {
      const { decryptSealboxB64Tag } = await import('./crypto.js');
      const result = await decryptSealboxB64Tag('');
      expect(result).toBeNull();
    });

    it('should return null when no private key path configured', async () => {
      delete process.env.CRED_SEALBOX_PRIVATE_KEY_PATH;
      vi.resetModules();
      const { decryptSealboxB64Tag } = await import('./crypto.js');
      const result = await decryptSealboxB64Tag('sealbox_x25519:b64:dGVzdA==');
      expect(result).toBeNull();
    });
  });

  describe('encryptToSealboxB64Tag', () => {
    it('should reject non-string input', async () => {
      const { encryptToSealboxB64Tag } = await import('./crypto.js');
      const result = await encryptToSealboxB64Tag(123);
      expect(result).toBeNull();
    });

    it('should reject null input', async () => {
      const { encryptToSealboxB64Tag } = await import('./crypto.js');
      const result = await encryptToSealboxB64Tag(null);
      expect(result).toBeNull();
    });

    it('should reject undefined input', async () => {
      const { encryptToSealboxB64Tag } = await import('./crypto.js');
      const result = await encryptToSealboxB64Tag(undefined);
      expect(result).toBeNull();
    });

    it('should return null when no private key path configured', async () => {
      delete process.env.CRED_SEALBOX_PRIVATE_KEY_PATH;
      vi.resetModules();
      const { encryptToSealboxB64Tag } = await import('./crypto.js');
      const result = await encryptToSealboxB64Tag('test-plaintext');
      expect(result).toBeNull();
    });

    it('should return null when key file does not exist', async () => {
      process.env.CRED_SEALBOX_PRIVATE_KEY_PATH = '/nonexistent/path/to/key';
      vi.resetModules();
      const { encryptToSealboxB64Tag } = await import('./crypto.js');
      const result = await encryptToSealboxB64Tag('test-plaintext');
      expect(result).toBeNull();
    });
  });

  describe('encryptCredentials', () => {
    it('should reject non-object input', async () => {
      const { encryptCredentials } = await import('./crypto.js');
      const result = await encryptCredentials('not-an-object');
      expect(result).toBeNull();
    });

    it('should reject null input', async () => {
      const { encryptCredentials } = await import('./crypto.js');
      const result = await encryptCredentials(null);
      expect(result).toBeNull();
    });

    it('should reject undefined input', async () => {
      const { encryptCredentials } = await import('./crypto.js');
      const result = await encryptCredentials(undefined);
      expect(result).toBeNull();
    });

    it('should return empty object when no credential fields present', async () => {
      const { encryptCredentials } = await import('./crypto.js');
      const result = await encryptCredentials({ someOtherField: 'value' });
      expect(result).not.toBeNull();
      expect(result).toEqual({});
    });

    it('should return null when encryption fails due to missing key', async () => {
      delete process.env.CRED_SEALBOX_PRIVATE_KEY_PATH;
      vi.resetModules();
      const { encryptCredentials } = await import('./crypto.js');
      const result = await encryptCredentials({ searchPassword: 'secret' });
      expect(result).toBeNull();
    });
  });

  describe('extractLinkedInCredentials', () => {
    it('should return null when no credentials provided', async () => {
      const { extractLinkedInCredentials } = await import('./crypto.js');
      const result = await extractLinkedInCredentials(null);
      expect(result).toBeNull();
    });

    it('should return null for empty string', async () => {
      const { extractLinkedInCredentials } = await import('./crypto.js');
      const result = await extractLinkedInCredentials('');
      expect(result).toBeNull();
    });

    it('should return null for undefined', async () => {
      const { extractLinkedInCredentials } = await import('./crypto.js');
      const result = await extractLinkedInCredentials(undefined);
      expect(result).toBeNull();
    });

    it('should return null when no encrypted credentials field', async () => {
      const { extractLinkedInCredentials } = await import('./crypto.js');
      const result = await extractLinkedInCredentials({ email: 'test@example.com' });
      expect(result).toBeNull();
    });

    it('should return null for empty body object', async () => {
      const { extractLinkedInCredentials } = await import('./crypto.js');
      const result = await extractLinkedInCredentials({});
      expect(result).toBeNull();
    });
  });
});
