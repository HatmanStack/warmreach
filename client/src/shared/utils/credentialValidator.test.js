import { describe, it, expect } from 'vitest';
import { validateLinkedInCredentials } from './credentialValidator.js';

describe('validateLinkedInCredentials', () => {
  describe('valid credentials', () => {
    it('accepts plaintext credentials with JWT', () => {
      const result = validateLinkedInCredentials({
        searchName: 'user@example.com',
        searchPassword: 'pass123',
        jwtToken: 'token-abc',
      });
      expect(result.isValid).toBe(true);
    });

    it('accepts ciphertext credentials with JWT', () => {
      const result = validateLinkedInCredentials({
        linkedinCredentialsCiphertext: 'sealbox_x25519:b64:encrypteddata==',
        jwtToken: 'token-abc',
      });
      expect(result.isValid).toBe(true);
    });

    it('accepts structured credentials with JWT', () => {
      const result = validateLinkedInCredentials({
        linkedinCredentials: { email: 'user@example.com', password: 'pass123' },
        jwtToken: 'token-abc',
      });
      expect(result.isValid).toBe(true);
    });

    it('accepts when multiple credential formats provided', () => {
      const result = validateLinkedInCredentials({
        searchName: 'user@example.com',
        searchPassword: 'pass123',
        linkedinCredentialsCiphertext: 'sealbox_x25519:b64:data==',
        jwtToken: 'token-abc',
      });
      expect(result.isValid).toBe(true);
    });
  });

  describe('missing credentials', () => {
    it('rejects when no credentials provided', () => {
      const result = validateLinkedInCredentials({ jwtToken: 'token-abc' });
      expect(result.isValid).toBe(false);
      expect(result.statusCode).toBe(400);
      expect(result.error).toContain('Missing credentials');
    });

    it('rejects partial plaintext (name only)', () => {
      const result = validateLinkedInCredentials({
        searchName: 'user@example.com',
        jwtToken: 'token-abc',
      });
      expect(result.isValid).toBe(false);
      expect(result.statusCode).toBe(400);
    });

    it('rejects partial plaintext (password only)', () => {
      const result = validateLinkedInCredentials({
        searchPassword: 'pass123',
        jwtToken: 'token-abc',
      });
      expect(result.isValid).toBe(false);
    });

    it('rejects ciphertext without sealbox prefix', () => {
      const result = validateLinkedInCredentials({
        linkedinCredentialsCiphertext: 'invalid-prefix:data',
        jwtToken: 'token-abc',
      });
      expect(result.isValid).toBe(false);
    });

    it('rejects non-string ciphertext', () => {
      const result = validateLinkedInCredentials({
        linkedinCredentialsCiphertext: 12345,
        jwtToken: 'token-abc',
      });
      expect(result.isValid).toBe(false);
    });

    it('rejects structured credentials without email', () => {
      const result = validateLinkedInCredentials({
        linkedinCredentials: { password: 'pass123' },
        jwtToken: 'token-abc',
      });
      expect(result.isValid).toBe(false);
    });

    it('rejects structured credentials without password', () => {
      const result = validateLinkedInCredentials({
        linkedinCredentials: { email: 'user@example.com' },
        jwtToken: 'token-abc',
      });
      expect(result.isValid).toBe(false);
    });
  });

  describe('JWT validation', () => {
    it('rejects when JWT is missing', () => {
      const result = validateLinkedInCredentials({
        searchName: 'user@example.com',
        searchPassword: 'pass123',
      });
      expect(result.isValid).toBe(false);
      expect(result.statusCode).toBe(401);
      expect(result.error).toContain('Authentication required');
    });

    it('includes actionType in error message', () => {
      const result = validateLinkedInCredentials({
        searchName: 'user@example.com',
        searchPassword: 'pass123',
        actionType: 'search',
      });
      expect(result.message).toContain('search');
    });

    it('defaults actionType to request', () => {
      const result = validateLinkedInCredentials({
        searchName: 'user@example.com',
        searchPassword: 'pass123',
      });
      expect(result.message).toContain('request');
    });
  });
});
