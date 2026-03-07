import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchRequestValidator } from './searchRequestValidator.js';
import { validateLinkedInCredentials } from '../../../shared/utils/credentialValidator.js';

// Mock dependencies
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../../shared/utils/credentialValidator.js', () => ({
  validateLinkedInCredentials: vi.fn(),
}));

describe('SearchRequestValidator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateRequest', () => {
    it('should call validateLinkedInCredentials with correct parameters', () => {
      const body = {
        companyName: 'Tech',
        linkedinCredentialsCiphertext: 'cipher',
      };
      const jwtToken = 'token';

      validateLinkedInCredentials.mockReturnValue({ isValid: true });

      const result = SearchRequestValidator.validateRequest(body, jwtToken);

      expect(validateLinkedInCredentials).toHaveBeenCalled();
      expect(result.isValid).toBe(true);
    });

    it('should handle missing company name', () => {
      const body = {
        linkedinCredentialsCiphertext: 'cipher',
      };
      const jwtToken = 'token';

      validateLinkedInCredentials.mockReturnValue({
        isValid: false,
        error: 'Company name is required',
        statusCode: 400,
      });

      const result = SearchRequestValidator.validateRequest(body, jwtToken);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Company name');
    });

    it('should handle missing credentials', () => {
      const body = {
        companyName: 'Tech',
      };
      const jwtToken = 'token';

      validateLinkedInCredentials.mockReturnValue({
        isValid: false,
        error: 'Credentials required',
        statusCode: 401,
      });

      const result = SearchRequestValidator.validateRequest(body, jwtToken);

      expect(result.isValid).toBe(false);
      expect(result.statusCode).toBe(401);
    });

    it('should handle missing JWT token', () => {
      const body = {
        companyName: 'Tech',
        linkedinCredentialsCiphertext: 'cipher',
      };

      validateLinkedInCredentials.mockReturnValue({
        isValid: false,
        error: 'Auth token required',
        statusCode: 401,
      });

      const result = SearchRequestValidator.validateRequest(body, null);

      expect(result.isValid).toBe(false);
      expect(result.statusCode).toBe(401);
    });
  });
});
