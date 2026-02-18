/**
 * @fileoverview Data validation using Zod schemas for the Connection Management System
 *
 * Validates and sanitizes Connection, Message, and filter data using Zod schemas.
 * All exported function signatures are preserved from the manual implementation.
 */

import { z } from 'zod';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('Validators');

import type {
  Connection,
  Message,
  ConnectionStatus,
  MessageSender,
  ValidationResult,
  TransformOptions,
} from './index';

import {
  isConnection,
  isMessage,
  isConnectionStatus,
  isMessageSender,
  isValidNumber,
  isValidISODate,
  isValidUrl,
  isConversionLikelihood,
} from './guards';

// =============================================================================
// VALIDATION CONSTANTS
// =============================================================================

const MAX_TEXT_LENGTH = {
  NAME: 100,
  POSITION: 200,
  COMPANY: 200,
  LOCATION: 100,
  HEADLINE: 500,
  SUMMARY: 2000,
  MESSAGE_CONTENT: 1000,
  TAG: 50,
} as const;

const MIN_TEXT_LENGTH = {
  NAME: 1,
  ID: 1,
  MESSAGE_CONTENT: 1,
} as const;

const MAX_ARRAY_LENGTH = {
  TAGS: 20,
  COMMON_INTERESTS: 50,
  MESSAGES: 1000,
} as const;

// =============================================================================
// BATCH VALIDATION RESULT
// =============================================================================

export interface BatchValidationResult {
  validConnections: Connection[];
  errors: Array<{ index: number; errors: string[] }>;
  warnings: string[];
}

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

const connectionStatusSchema = z.enum(['possible', 'incoming', 'outgoing', 'ally', 'processed']);
const messageSenderSchema = z.enum(['user', 'connection']);
const conversionLikelihoodSchema = z.enum(['high', 'medium', 'low']);

const messageSchema = z.object({
  id: z.string().min(1, 'Message ID is required and must be a non-empty string'),
  content: z
    .string()
    .min(
      MIN_TEXT_LENGTH.MESSAGE_CONTENT,
      'Message content is required and must be at least 1 character'
    )
    .max(
      MAX_TEXT_LENGTH.MESSAGE_CONTENT,
      `Message content is too long (max ${MAX_TEXT_LENGTH.MESSAGE_CONTENT} characters)`
    ),
  timestamp: z.string().refine(isValidISODate, 'Message timestamp must be a valid ISO date string'),
  sender: messageSenderSchema,
});

const connectionSchema = z.object({
  id: z
    .string()
    .min(1, 'Connection ID is required and must be a non-empty string')
    .max(
      MAX_TEXT_LENGTH.NAME * 2,
      `Connection ID is too long (max ${MAX_TEXT_LENGTH.NAME * 2} characters)`
    ),
  first_name: z
    .string()
    .min(MIN_TEXT_LENGTH.NAME, 'First name is required and must be at least 1 character')
    .max(MAX_TEXT_LENGTH.NAME, `First name is too long (max ${MAX_TEXT_LENGTH.NAME} characters)`),
  last_name: z
    .string()
    .min(MIN_TEXT_LENGTH.NAME, 'Last name is required and must be at least 1 character')
    .max(MAX_TEXT_LENGTH.NAME, `Last name is too long (max ${MAX_TEXT_LENGTH.NAME} characters)`),
  position: z
    .string()
    .max(
      MAX_TEXT_LENGTH.POSITION,
      `Position is too long (max ${MAX_TEXT_LENGTH.POSITION} characters)`
    ),
  company: z
    .string()
    .max(
      MAX_TEXT_LENGTH.COMPANY,
      `Company is too long (max ${MAX_TEXT_LENGTH.COMPANY} characters)`
    ),
  status: connectionStatusSchema,
  location: z.string().max(MAX_TEXT_LENGTH.LOCATION).optional(),
  headline: z.string().max(MAX_TEXT_LENGTH.HEADLINE).optional(),
  recent_activity: z.string().max(MAX_TEXT_LENGTH.SUMMARY).optional(),
  last_action_summary: z.string().max(MAX_TEXT_LENGTH.SUMMARY).optional(),
  last_activity_summary: z.string().max(MAX_TEXT_LENGTH.SUMMARY).optional(),
  messages: z.number().nonnegative('Message count must be a non-negative number').optional(),
  conversion_likelihood: conversionLikelihoodSchema.optional(),
  date_added: z.string().refine(isValidISODate).optional(),
  linkedin_url: z.string().refine(isValidUrl).optional(),
  common_interests: z
    .array(z.string().min(1).max(MAX_TEXT_LENGTH.TAG))
    .max(MAX_ARRAY_LENGTH.COMMON_INTERESTS)
    .optional(),
  tags: z.array(z.string().min(1).max(MAX_TEXT_LENGTH.TAG)).max(MAX_ARRAY_LENGTH.TAGS).optional(),
  profile_picture_url: z.string().url().max(500).optional(),
  message_history: z.array(messageSchema).max(MAX_ARRAY_LENGTH.MESSAGES).optional(),
  isFakeData: z.boolean().optional(),
});

// =============================================================================
// SANITIZATION HELPERS
// =============================================================================

function sanitizeString(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) return value.trim();
  return fallback;
}

function sanitizeConnectionStatus(value: unknown): ConnectionStatus | null {
  if (isConnectionStatus(value)) return value;
  if (typeof value === 'string') {
    const n = value.toLowerCase().trim();
    switch (n) {
      case 'new':
      case 'potential':
        return 'possible';
      case 'pending':
      case 'received':
        return 'incoming';
      case 'sent':
      case 'requested':
        return 'outgoing';
      case 'connected':
      case 'accepted':
        return 'ally';
      case 'removed':
      case 'ignored':
        return 'processed';
      default:
        return null;
    }
  }
  return null;
}

function sanitizeMessageSender(value: unknown): MessageSender | null {
  if (isMessageSender(value)) return value;
  if (typeof value === 'string') {
    const n = value.toLowerCase().trim();
    if (['user', 'me', 'self'].includes(n)) return 'user';
    if (['connection', 'contact', 'them', 'other'].includes(n)) return 'connection';
  }
  return null;
}

function sanitizeTimestamp(value: unknown): string | null {
  if (typeof value === 'string' && isValidISODate(value)) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && isFinite(value)) {
    try {
      return new Date(value).toISOString();
    } catch {
      return null;
    }
  }
  if (typeof value === 'string') {
    try {
      const d = new Date(value);
      if (!isNaN(d.getTime())) return d.toISOString();
    } catch {
      /* fall through */
    }
  }
  return null;
}

// =============================================================================
// CORE VALIDATION FUNCTIONS
// =============================================================================

export function validateConnection(
  connection: unknown,
  options: TransformOptions = {}
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let sanitizedData: Partial<Connection> | null = null;

  if (!isConnection(connection)) {
    if (options.sanitize) {
      sanitizedData = sanitizeConnectionData(connection);
      if (sanitizedData && isConnection(sanitizedData)) {
        warnings.push('Connection data was sanitized to fix validation issues');
      } else {
        errors.push('Unable to sanitize connection data - invalid structure');
        return { isValid: false, errors, warnings };
      }
    } else {
      errors.push('Invalid connection object structure');
      return { isValid: false, errors, warnings };
    }
  }

  const conn = (sanitizedData || connection) as Connection;
  const result = connectionSchema.safeParse(conn);

  if (!result.success) {
    for (const issue of result.error.issues) {
      const msg = issue.message;
      // Treat optional field length warnings as warnings, not errors
      const path0 = String(issue.path[0] ?? '');
      const isOptionalField = [
        'location',
        'headline',
        'recent_activity',
        'last_action_summary',
        'date_added',
        'linkedin_url',
        'profile_picture_url',
      ].includes(path0);
      if (isOptionalField && issue.code === 'too_big') {
        warnings.push(msg);
      } else {
        errors.push(msg);
      }
    }
  }

  // Additional warnings for optional fields that are valid but notable
  if (conn.location && conn.location.length > MAX_TEXT_LENGTH.LOCATION) {
    if (!warnings.some((w) => w.includes('Location')))
      warnings.push(`Location is too long (max ${MAX_TEXT_LENGTH.LOCATION} characters)`);
  }
  if (conn.headline && conn.headline.length > MAX_TEXT_LENGTH.HEADLINE) {
    if (!warnings.some((w) => w.includes('Headline')))
      warnings.push(`Headline is too long (max ${MAX_TEXT_LENGTH.HEADLINE} characters)`);
  }
  if (conn.recent_activity && conn.recent_activity.length > MAX_TEXT_LENGTH.SUMMARY) {
    if (!warnings.some((w) => w.includes('Recent activity')))
      warnings.push(`Recent activity is too long (max ${MAX_TEXT_LENGTH.SUMMARY} characters)`);
  }
  if (conn.last_action_summary && conn.last_action_summary.length > MAX_TEXT_LENGTH.SUMMARY) {
    if (!warnings.some((w) => w.includes('Last action summary')))
      warnings.push(`Last action summary is too long (max ${MAX_TEXT_LENGTH.SUMMARY} characters)`);
  }

  if (conn.message_history) {
    conn.message_history.forEach((message, index) => {
      const mv = validateMessage(message);
      if (!mv.isValid) {
        errors.push(`Message at index ${index}: ${mv.errors.join(', ')}`);
      }
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    sanitizedData: sanitizedData || undefined,
  };
}

export function validateMessage(
  message: unknown,
  options: TransformOptions = {}
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let sanitizedData: Partial<Message> | null = null;

  if (!isMessage(message)) {
    if (options.sanitize) {
      sanitizedData = sanitizeMessageData(message);
      if (sanitizedData && isMessage(sanitizedData)) {
        warnings.push('Message data was sanitized to fix validation issues');
      } else {
        errors.push('Unable to sanitize message data - invalid structure');
        return { isValid: false, errors, warnings };
      }
    } else {
      errors.push('Invalid message object structure');
      return { isValid: false, errors, warnings };
    }
  }

  const msg = (sanitizedData || message) as Message;
  const result = messageSchema.safeParse(msg);

  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(issue.message);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    sanitizedData: sanitizedData || undefined,
  };
}

// =============================================================================
// DATA SANITIZATION FUNCTIONS
// =============================================================================

export function sanitizeConnectionData(data: unknown): Connection | null {
  if (typeof data !== 'object' || data === null) return null;
  const obj = data as Record<string, unknown>;

  try {
    const id = sanitizeString(obj.id, 'unknown-connection');
    const first_name = sanitizeString(obj.first_name, 'Unknown');
    const last_name = sanitizeString(obj.last_name, '');
    const position = sanitizeString(obj.position, '');
    const company = sanitizeString(obj.company, '');
    const status = sanitizeConnectionStatus(obj.status);
    if (!status) return null;

    const connection: Connection = {
      id: id.substring(0, MAX_TEXT_LENGTH.NAME * 2),
      first_name: first_name.substring(0, MAX_TEXT_LENGTH.NAME),
      last_name: last_name.substring(0, MAX_TEXT_LENGTH.NAME),
      position: position.substring(0, MAX_TEXT_LENGTH.POSITION),
      company: company.substring(0, MAX_TEXT_LENGTH.COMPANY),
      status,
    };

    if (obj.location && typeof obj.location === 'string')
      connection.location = obj.location.substring(0, MAX_TEXT_LENGTH.LOCATION);
    if (obj.headline && typeof obj.headline === 'string')
      connection.headline = obj.headline.substring(0, MAX_TEXT_LENGTH.HEADLINE);
    if (obj.recent_activity && typeof obj.recent_activity === 'string')
      connection.recent_activity = obj.recent_activity.substring(0, MAX_TEXT_LENGTH.SUMMARY);
    if (obj.last_action_summary && typeof obj.last_action_summary === 'string')
      connection.last_action_summary = obj.last_action_summary.substring(
        0,
        MAX_TEXT_LENGTH.SUMMARY
      );
    if (obj.last_activity_summary && typeof obj.last_activity_summary === 'string')
      connection.last_activity_summary = obj.last_activity_summary.substring(
        0,
        MAX_TEXT_LENGTH.SUMMARY
      );
    if (isValidNumber(obj.messages) && (obj.messages as number) >= 0)
      connection.messages = Math.floor(obj.messages as number);
    if (isConversionLikelihood(obj.conversion_likelihood))
      connection.conversion_likelihood = obj.conversion_likelihood;
    if (typeof obj.date_added === 'string' && isValidISODate(obj.date_added))
      connection.date_added = obj.date_added;
    if (typeof obj.linkedin_url === 'string' && isValidUrl(obj.linkedin_url))
      connection.linkedin_url = obj.linkedin_url;
    if (
      typeof obj.profile_picture_url === 'string' &&
      obj.profile_picture_url.length > 0 &&
      isValidUrl(obj.profile_picture_url)
    )
      connection.profile_picture_url = obj.profile_picture_url.substring(0, 500);
    if (typeof obj.isFakeData === 'boolean') connection.isFakeData = obj.isFakeData;
    if (Array.isArray(obj.common_interests)) {
      connection.common_interests = obj.common_interests
        .filter((item) => typeof item === 'string' && item.length > 0)
        .map((item) => (item as string).substring(0, MAX_TEXT_LENGTH.TAG))
        .slice(0, MAX_ARRAY_LENGTH.COMMON_INTERESTS);
    }
    if (Array.isArray(obj.tags)) {
      connection.tags = obj.tags
        .filter((item) => typeof item === 'string' && item.length > 0)
        .map((item) => (item as string).substring(0, MAX_TEXT_LENGTH.TAG))
        .slice(0, MAX_ARRAY_LENGTH.TAGS);
    }
    if (Array.isArray(obj.message_history)) {
      connection.message_history = obj.message_history
        .map(sanitizeMessageData)
        .filter((msg): msg is Message => msg !== null)
        .slice(0, MAX_ARRAY_LENGTH.MESSAGES);
    }

    return connection;
  } catch (error) {
    logger.warn('Error sanitizing connection data', { error });
    return null;
  }
}

export function sanitizeMessageData(data: unknown): Message | null {
  if (typeof data !== 'object' || data === null) return null;
  const obj = data as Record<string, unknown>;

  try {
    const id = sanitizeString(obj.id, `msg-${Date.now()}`);
    const content = sanitizeString(obj.content, '');
    const timestamp = sanitizeTimestamp(obj.timestamp);
    const sender = sanitizeMessageSender(obj.sender);
    if (!content || !timestamp || !sender) return null;

    return {
      id,
      content: content.substring(0, MAX_TEXT_LENGTH.MESSAGE_CONTENT),
      timestamp,
      sender,
    };
  } catch (error) {
    logger.warn('Error sanitizing message data', { error });
    return null;
  }
}

// =============================================================================
// BATCH VALIDATION FUNCTIONS
// =============================================================================

export function validateConnections(
  connections: unknown[],
  options: TransformOptions = {}
): BatchValidationResult {
  const validConnections: Connection[] = [];
  const errors: Array<{ index: number; errors: string[] }> = [];
  const warnings: string[] = [];

  connections.forEach((conn, index) => {
    const result = validateConnection(conn, options);
    if (result.isValid && conn) {
      validConnections.push(conn as Connection);
    } else if (result.sanitizedData) {
      validConnections.push(result.sanitizedData as Connection);
      warnings.push(`Connection at index ${index} was sanitized`);
    } else {
      errors.push({ index, errors: result.errors });
    }
    if (result.warnings && result.warnings.length > 0) {
      result.warnings.forEach((w) => warnings.push(`Connection ${index}: ${w}`));
    }
  });

  return { validConnections, errors, warnings };
}
