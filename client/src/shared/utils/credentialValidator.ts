/**
 * Credential Validator
 *
 * Provides validation utilities for LinkedIn credentials across different formats
 * (plaintext, ciphertext, structured). Used by search and profile controllers.
 */

interface StructuredCredentials {
  email?: string;
  password?: string;
}

interface ValidateLinkedInCredentialsParams {
  searchName?: string;
  searchPassword?: string;
  linkedinCredentialsCiphertext?: string;
  linkedinCredentials?: StructuredCredentials;
  jwtToken?: string;
  actionType?: string;
}

interface ValidationSuccess {
  isValid: true;
}

interface ValidationFailure {
  isValid: false;
  statusCode: number;
  error: string;
  message?: string;
}

export type CredentialValidationResult = ValidationSuccess | ValidationFailure;

export function validateLinkedInCredentials({
  searchName,
  searchPassword,
  linkedinCredentialsCiphertext,
  linkedinCredentials,
  jwtToken,
  actionType = 'request',
}: ValidateLinkedInCredentialsParams): CredentialValidationResult {
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
