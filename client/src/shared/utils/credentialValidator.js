/**
 * Credential Validator
 *
 * Provides validation utilities for LinkedIn credentials across different formats
 * (plaintext, ciphertext, structured). Used by search and profile controllers.
 */

/**
 * Validate LinkedIn credentials for requests
 *
 * Accepts credentials in multiple formats:
 * - Plaintext: searchName + searchPassword
 * - Ciphertext: linkedinCredentialsCiphertext (sealbox encrypted)
 * - Structured: linkedinCredentials object with email/password
 *
 * @param {Object} params - Credential parameters
 * @param {string} [params.searchName] - LinkedIn email (plaintext)
 * @param {string} [params.searchPassword] - LinkedIn password (plaintext)
 * @param {string} [params.linkedinCredentialsCiphertext] - Encrypted credentials
 * @param {Object} [params.linkedinCredentials] - Structured credentials object
 * @param {string} [params.jwtToken] - User authentication token
 * @param {string} [params.actionType='request'] - Type of action being performed (for error messages)
 * @returns {Object} Validation result
 * @returns {boolean} result.isValid - Whether credentials are valid
 * @returns {number} [result.statusCode] - HTTP status code if invalid
 * @returns {string} [result.error] - Error message if invalid
 * @returns {string} [result.message] - Additional context if invalid
 */
export function validateLinkedInCredentials({
  searchName,
  searchPassword,
  linkedinCredentialsCiphertext,
  linkedinCredentials,
  jwtToken,
  actionType = 'request',
}) {
  // Check for at least one valid credential format
  const hasPlaintext = !!(searchName && searchPassword);
  const hasCiphertext =
    typeof linkedinCredentialsCiphertext === 'string' &&
    linkedinCredentialsCiphertext.startsWith('sealbox_x25519:b64:');
  const hasStructured = !!(
    linkedinCredentials &&
    linkedinCredentials.email &&
    linkedinCredentials.password
  );

  if (!hasPlaintext && !hasCiphertext && !hasStructured) {
    return {
      isValid: false,
      statusCode: 400,
      error:
        'Missing credentials: provide searchName/searchPassword or linkedinCredentialsCiphertext',
    };
  }

  // JWT token is required for user identification
  if (!jwtToken) {
    return {
      isValid: false,
      statusCode: 401,
      error: 'Authentication required',
      message: `User ID is required to perform ${actionType}s`,
    };
  }

  return { isValid: true };
}
