import { logger } from '#utils/logger.js';
import { verifyJwtSignature } from './jwksValidator.js';

// Clock skew tolerance in seconds (allows for minor time sync differences)
const CLOCK_SKEW_TOLERANCE_SECONDS = 30;

// Signature verification enabled by default; opt out with JWT_VERIFY_SIGNATURE=false
const VERIFY_SIGNATURE = process.env.JWT_VERIFY_SIGNATURE !== 'false';

/**
 * Validate a JWT token for structure, expiration, and required claims.
 * Does NOT verify the signature (per ADR-001 - expiration + structure validation only).
 *
 * @param {string} token - The JWT token to validate
 * @returns {Object} Validation result:
 *   - { valid: true, payload: Object, userId: string } on success
 *   - { valid: false, reason: string } on failure
 */
export function validateJwt(token) {
  // Check for missing token
  if (!token) {
    logger.warn('JWT validation failed: No token provided');
    return { valid: false, reason: 'No token provided' };
  }

  // Validate structure: JWT must have exactly 3 dot-separated parts
  const parts = token.split('.');
  if (parts.length !== 3) {
    logger.warn('JWT validation failed: Malformed token (expected 3 parts)');
    return { valid: false, reason: 'Malformed token' };
  }

  // Decode payload (second part)
  let payload;
  try {
    payload = decodeJwtPayload(parts[1]);
  } catch (error) {
    logger.warn('JWT validation failed: ' + error.message);
    return { valid: false, reason: error.message };
  }

  // Validate expiration claim exists
  if (payload.exp === undefined || payload.exp === null) {
    logger.warn('JWT validation failed: Missing exp claim');
    return { valid: false, reason: 'Missing exp claim' };
  }

  // Check if token is expired (with clock skew tolerance)
  const currentTime = Math.floor(Date.now() / 1000);
  const expirationWithSkew = payload.exp + CLOCK_SKEW_TOLERANCE_SECONDS;

  if (currentTime > expirationWithSkew) {
    logger.warn('JWT validation failed: Token expired', {
      exp: payload.exp,
      currentTime,
      toleranceSeconds: CLOCK_SKEW_TOLERANCE_SECONDS,
    });
    return { valid: false, reason: 'Token expired' };
  }

  // Extract user ID from common claim names (in order of preference)
  const rawUserId = payload.sub || payload.user_id || payload.userId || payload.id;

  if (!rawUserId) {
    logger.warn('JWT validation failed: Missing user identifier', {
      availableClaims: Object.keys(payload),
    });
    return { valid: false, reason: 'Missing user identifier' };
  }

  // Ensure userId is a string for safe logging and downstream use
  const userId = typeof rawUserId === 'string' ? rawUserId : String(rawUserId);

  logger.debug('JWT validation successful', {
    userId: userId.substring(0, 8) + '...',
    exp: payload.exp,
  });

  return {
    valid: true,
    payload,
    userId,
  };
}

/**
 * Decode the JWT payload from base64url encoding.
 *
 * @param {string} payloadB64 - Base64url encoded payload
 * @returns {Object} Decoded payload object
 * @throws {Error} If decoding or parsing fails
 */
function decodeJwtPayload(payloadB64) {
  try {
    // Convert base64url to standard base64
    // Replace URL-safe characters and add padding if needed
    let base64 = payloadB64.replace(/-/g, '+').replace(/_/g, '/');

    // Add padding if needed
    const padding = base64.length % 4;
    if (padding) {
      base64 += '='.repeat(4 - padding);
    }

    // Decode base64
    const decoded = Buffer.from(base64, 'base64').toString('utf8');

    // Validate it's not empty or garbage
    if (!decoded || decoded.length === 0) {
      throw new Error('Invalid payload encoding');
    }

    // Parse JSON
    try {
      return JSON.parse(decoded);
    } catch {
      throw new Error('Invalid payload JSON');
    }
  } catch (error) {
    if (error.message === 'Invalid payload JSON' || error.message === 'Invalid payload encoding') {
      throw error;
    }
    throw new Error('Invalid payload encoding');
  }
}

/**
 * Validate a JWT token with optional signature verification.
 *
 * Performs full cryptographic signature verification using the Cognito
 * JWKS endpoint by default. Set JWT_VERIFY_SIGNATURE=false to disable
 * and only validate structure and expiration.
 *
 * @param {string} token - The JWT token to validate
 * @returns {Promise<Object>} Validation result:
 *   - { valid: true, payload: Object, userId: string, signatureVerified?: boolean } on success
 *   - { valid: false, reason: string } on failure
 */
export async function validateJwtFull(token) {
  // First do quick structural validation
  const structuralResult = validateJwt(token);
  if (!structuralResult.valid) {
    return structuralResult;
  }

  // If signature verification is disabled, return structural result
  if (!VERIFY_SIGNATURE) {
    return {
      ...structuralResult,
      signatureVerified: false,
    };
  }

  // Perform full signature verification
  logger.debug('Performing JWT signature verification');
  return verifyJwtSignature(token);
}

/**
 * Check if signature verification is enabled.
 * @returns {boolean} True unless JWT_VERIFY_SIGNATURE=false
 */
export function isSignatureVerificationEnabled() {
  return VERIFY_SIGNATURE;
}
