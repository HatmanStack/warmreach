import { logger } from '#utils/logger.js';

// Clock skew tolerance in seconds (allows for minor time sync differences)
const CLOCK_SKEW_TOLERANCE_SECONDS = 30;

interface JwtPayload {
  exp?: number | null;
  sub?: string;
  user_id?: string;
  userId?: string;
  id?: string;
  [key: string]: unknown;
}

interface JwtValidSuccess {
  valid: true;
  payload: JwtPayload;
  userId: string;
}

interface JwtValidFailure {
  valid: false;
  reason: string;
}

export type JwtValidationResult = JwtValidSuccess | JwtValidFailure;

export function validateJwt(token: string | undefined | null): JwtValidationResult {
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
  let payload: JwtPayload;
  try {
    payload = decodeJwtPayload(parts[1]!);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.warn('JWT validation failed: ' + message);
    return { valid: false, reason: message };
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

function decodeJwtPayload(payloadB64: string): JwtPayload {
  try {
    // Convert base64url to standard base64
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
      return JSON.parse(decoded) as JwtPayload;
    } catch {
      throw new Error('Invalid payload JSON');
    }
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error('Invalid payload encoding');
    if (err.message === 'Invalid payload JSON' || err.message === 'Invalid payload encoding') {
      throw err;
    }
    throw new Error('Invalid payload encoding');
  }
}
