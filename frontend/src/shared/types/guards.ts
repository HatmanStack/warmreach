/**
 * @fileoverview Type guards for runtime type checking in the Connection Management System
 *
 * This file contains type guard functions that provide runtime type safety by checking
 * if values conform to expected interfaces. These are essential for validating data
 * from external sources like APIs and user input.
 *
 * @author Connection Management System
 * @version 1.0.0
 */

import type {
  Connection,
  Message,
  ConnectionStatus,
  MessageSender,
  ConnectionFilters,
  ApiResponse,
} from './index';

// =============================================================================
// PRIMITIVE TYPE GUARDS
// =============================================================================

/**
 * Checks if a value is a non-empty string
 *
 * @param value - The value to check
 * @returns True if value is a non-empty string
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Checks if a value is a valid number
 *
 * @param value - The value to check
 * @returns True if value is a finite number
 */
export function isValidNumber(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value);
}

/**
 * Checks if a value is a valid positive integer
 *
 * @param value - The value to check
 * @returns True if value is a positive integer
 */
export function isPositiveInteger(value: unknown): value is number {
  return isValidNumber(value) && value > 0 && Number.isInteger(value);
}

/**
 * Checks if a value is a valid ISO date string
 *
 * @param value - The value to check
 * @returns True if value is a valid ISO date string
 */
export function isValidISODate(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;

  try {
    const date = new Date(value);
    return date.toISOString() === value;
  } catch {
    return false;
  }
}

/**
 * Checks if a value is a valid URL string
 *
 * @param value - The value to check
 * @returns True if value is a valid URL
 */
export function isValidUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;

  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// ENUM TYPE GUARDS
// =============================================================================

/**
 * Checks if a value is a valid ConnectionStatus
 *
 * @param value - The value to check
 * @returns True if value is a valid ConnectionStatus
 */
export function isConnectionStatus(value: unknown): value is ConnectionStatus {
  return (
    typeof value === 'string' &&
    ['possible', 'incoming', 'outgoing', 'ally', 'processed'].includes(value)
  );
}

/**
 * Checks if a value is a valid MessageSender
 *
 * @param value - The value to check
 * @returns True if value is a valid MessageSender
 */
export function isMessageSender(value: unknown): value is MessageSender {
  return typeof value === 'string' && ['user', 'connection'].includes(value);
}

/**
 * Checks if a value is a valid ConversionLikelihood
 *
 * @param value - The value to check
 * @returns True if value is a valid ConversionLikelihood enum string
 */
export function isConversionLikelihood(
  value: unknown
): value is import('./index').ConversionLikelihood {
  return typeof value === 'string' && ['high', 'medium', 'low'].includes(value);
}

// =============================================================================
// CORE INTERFACE TYPE GUARDS
// =============================================================================

/**
 * Checks if a value is a valid Message object
 *
 * @param value - The value to check
 * @returns True if value conforms to Message interface
 */
export function isMessage(value: unknown): value is Message {
  if (typeof value !== 'object' || value === null) return false;

  const obj = value as Record<string, unknown>;

  return (
    isNonEmptyString(obj.id) &&
    typeof obj.content === 'string' &&
    isNonEmptyString(obj.timestamp) &&
    isMessageSender(obj.sender)
  );
}

/**
 * Checks if a value is a valid Connection object
 *
 * @param value - The value to check
 * @returns True if value conforms to Connection interface
 */
export function isConnection(value: unknown): value is Connection {
  if (typeof value !== 'object' || value === null) return false;

  const obj = value as Record<string, unknown>;

  // Check required fields
  if (
    !isNonEmptyString(obj.id) ||
    typeof obj.first_name !== 'string' ||
    typeof obj.last_name !== 'string' ||
    typeof obj.position !== 'string' ||
    typeof obj.company !== 'string' ||
    !isConnectionStatus(obj.status)
  ) {
    return false;
  }

  // Check optional fields if they exist
  if (obj.location !== undefined && typeof obj.location !== 'string') return false;
  if (obj.headline !== undefined && typeof obj.headline !== 'string') return false;
  if (obj.recent_activity !== undefined && typeof obj.recent_activity !== 'string') return false;
  if (obj.messages !== undefined && !isValidNumber(obj.messages)) return false;
  if (obj.date_added !== undefined && typeof obj.date_added !== 'string') return false;
  if (obj.linkedin_url !== undefined && typeof obj.linkedin_url !== 'string') return false;
  if (obj.last_action_summary !== undefined && typeof obj.last_action_summary !== 'string')
    return false;
  if (obj.last_activity_summary !== undefined && typeof obj.last_activity_summary !== 'string')
    return false;
  if (obj.conversion_likelihood !== undefined && !isConversionLikelihood(obj.conversion_likelihood))
    return false;
  if (obj.isFakeData !== undefined && typeof obj.isFakeData !== 'boolean') return false;

  // Check array fields
  if (obj.common_interests !== undefined) {
    if (
      !Array.isArray(obj.common_interests) ||
      !obj.common_interests.every((item) => typeof item === 'string')
    ) {
      return false;
    }
  }

  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || !obj.tags.every((item) => typeof item === 'string')) {
      return false;
    }
  }

  if (obj.message_history !== undefined) {
    if (!Array.isArray(obj.message_history) || !obj.message_history.every(isMessage)) {
      return false;
    }
  }

  return true;
}

/**
 * Checks if a value is a valid ConnectionFilters object
 *
 * @param value - The value to check
 * @returns True if value conforms to ConnectionFilters interface
 */
export function isConnectionFilters(value: unknown): value is ConnectionFilters {
  if (typeof value !== 'object' || value === null) return false;

  const obj = value as Record<string, unknown>;

  // All fields are optional, so check only if they exist
  if (obj.status !== undefined) {
    if (!(isConnectionStatus(obj.status) || obj.status === 'all')) {
      return false;
    }
  }

  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || !obj.tags.every((item) => typeof item === 'string')) {
      return false;
    }
  }

  if (obj.company !== undefined && typeof obj.company !== 'string') return false;
  if (obj.location !== undefined && typeof obj.location !== 'string') return false;
  if (obj.searchTerm !== undefined && typeof obj.searchTerm !== 'string') return false;

  return true;
}

// =============================================================================
// API RESPONSE TYPE GUARDS
// =============================================================================

/**
 * Checks if a value is a valid ApiResponse object
 *
 * @param value - The value to check
 * @returns True if value conforms to ApiResponse interface
 */
export function isApiResponse<T>(
  value: unknown,
  bodyValidator?: (body: unknown) => body is T
): value is ApiResponse<T> {
  if (typeof value !== 'object' || value === null) return false;

  const obj = value as Record<string, unknown>;

  if (!isValidNumber(obj.statusCode)) return false;
  if (obj.body === undefined) return false;
  if (obj.error !== undefined && typeof obj.error !== 'string') return false;

  // If a body validator is provided, use it
  if (bodyValidator && !bodyValidator(obj.body)) return false;

  return true;
}

// Removed unused response type guards: isGetConnectionsResponse, isGetMessagesResponse, isUpdateMetadataResponse

// =============================================================================
// ERROR TYPE GUARDS
// =============================================================================

// =============================================================================
// PARAMETER TYPE GUARDS
// =============================================================================

// Removed unused database operation type guards: isConnectionQueryParams, isUpdateConnectionParams
