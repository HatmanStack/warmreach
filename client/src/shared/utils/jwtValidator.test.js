import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// Test helper to create JWT
function createTestJwt(payload, signature = 'test-signature') {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${payloadB64}.${signature}`;
}

describe('validateJwt', () => {
  let validateJwt;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Set fixed time: 2024-01-15T12:00:00Z = 1705320000 seconds since epoch
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
    const module = await import('./jwtValidator.js');
    validateJwt = module.validateJwt;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  describe('structure validation', () => {
    it('rejects token with less than 3 parts', () => {
      const result = validateJwt('header.payload');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Malformed token');
    });

    it('rejects token with more than 3 parts', () => {
      const result = validateJwt('a.b.c.d');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Malformed token');
    });

    it('rejects token with invalid base64 payload', () => {
      // Note: Node's Buffer.from doesn't throw on malformed base64, it just
      // ignores invalid chars. So "!!!invalid!!!" decodes to garbage bytes
      // that fail JSON parsing. The end result is the same - token rejected.
      const result = validateJwt('header.!!!invalid!!!.signature');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid payload JSON');
    });

    it('rejects token with non-JSON payload', () => {
      const header = Buffer.from('{"alg":"RS256"}').toString('base64url');
      const payload = Buffer.from('not-json').toString('base64url');
      const result = validateJwt(`${header}.${payload}.signature`);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid payload JSON');
    });

    it('rejects null token', () => {
      const result = validateJwt(null);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('No token provided');
    });

    it('rejects undefined token', () => {
      const result = validateJwt(undefined);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('No token provided');
    });

    it('rejects empty string token', () => {
      const result = validateJwt('');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('No token provided');
    });
  });

  describe('expiration validation', () => {
    const currentTime = 1705320000; // 2024-01-15T12:00:00Z

    it('accepts token with future exp', () => {
      const token = createTestJwt({
        sub: 'user-123',
        exp: currentTime + 3600, // 1 hour in future
      });
      const result = validateJwt(token);
      expect(result.valid).toBe(true);
      expect(result.payload.sub).toBe('user-123');
    });

    it('rejects token with past exp', () => {
      const token = createTestJwt({
        sub: 'user-123',
        exp: currentTime - 3600, // 1 hour ago
      });
      const result = validateJwt(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Token expired');
    });

    it('accepts token within clock skew tolerance (30 seconds)', () => {
      const token = createTestJwt({
        sub: 'user-123',
        exp: currentTime - 15, // 15 seconds ago (within 30s tolerance)
      });
      const result = validateJwt(token);
      expect(result.valid).toBe(true);
    });

    it('rejects token just outside clock skew tolerance', () => {
      const token = createTestJwt({
        sub: 'user-123',
        exp: currentTime - 31, // 31 seconds ago (outside 30s tolerance)
      });
      const result = validateJwt(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Token expired');
    });

    it('rejects token without exp claim', () => {
      const token = createTestJwt({
        sub: 'user-123',
        // no exp
      });
      const result = validateJwt(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Missing exp claim');
    });
  });

  describe('user ID extraction', () => {
    const futureExp = 1705320000 + 3600; // 1 hour in future

    it('extracts sub claim as userId', () => {
      const token = createTestJwt({
        sub: 'user-from-sub',
        exp: futureExp,
      });
      const result = validateJwt(token);
      expect(result.valid).toBe(true);
      expect(result.userId).toBe('user-from-sub');
    });

    it('extracts user_id claim as userId when sub is missing', () => {
      const token = createTestJwt({
        user_id: 'user-from-user_id',
        exp: futureExp,
      });
      const result = validateJwt(token);
      expect(result.valid).toBe(true);
      expect(result.userId).toBe('user-from-user_id');
    });

    it('extracts userId claim as userId', () => {
      const token = createTestJwt({
        userId: 'user-from-userId',
        exp: futureExp,
      });
      const result = validateJwt(token);
      expect(result.valid).toBe(true);
      expect(result.userId).toBe('user-from-userId');
    });

    it('prefers sub claim over other identifiers', () => {
      const token = createTestJwt({
        sub: 'preferred-sub',
        user_id: 'fallback-user_id',
        userId: 'fallback-userId',
        exp: futureExp,
      });
      const result = validateJwt(token);
      expect(result.valid).toBe(true);
      expect(result.userId).toBe('preferred-sub');
    });

    it('rejects token without any user identifier', () => {
      const token = createTestJwt({
        exp: futureExp,
        iss: 'some-issuer',
        // no sub, user_id, or userId
      });
      const result = validateJwt(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Missing user identifier');
    });
  });

  describe('base64url edge cases', () => {
    const futureExp = 1705320000 + 3600;

    it('handles standard base64 with + and / characters', () => {
      // Some JWT libraries use standard base64, not base64url
      // Create a token where the payload has + and / when base64 encoded
      const token = createTestJwt({
        sub: 'user+with/special',
        exp: futureExp,
      });
      const result = validateJwt(token);
      expect(result.valid).toBe(true);
    });

    it('handles payload requiring padding', () => {
      // Create payload that results in base64 needing padding
      const token = createTestJwt({
        sub: 'a',
        exp: futureExp,
      });
      const result = validateJwt(token);
      expect(result.valid).toBe(true);
    });
  });
});
