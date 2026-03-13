/**
 * Structured error class for LinkedIn operations.
 * Carries a machine-readable `code` that maps to ERROR_CODES keys
 * in LinkedInErrorHandler, eliminating fragile string matching.
 */
export class LinkedInError extends Error {
  /**
   * @param {string} message - Human-readable error message
   * @param {string} code - Machine-readable code matching ERROR_CODES key
   * @param {Object} [options] - Additional options
   * @param {Error} [options.cause] - Original error that caused this
   */
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = 'LinkedInError';
    this.code = code;
  }
}
