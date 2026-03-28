/**
 * Structured error class for LinkedIn operations.
 * Carries a machine-readable `code` that maps to ERROR_CODES keys
 * in LinkedInErrorHandler, eliminating fragile string matching.
 */
export class LinkedInError extends Error {
  code: string;

  constructor(message: string, code: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'LinkedInError';
    this.code = code;
  }
}
