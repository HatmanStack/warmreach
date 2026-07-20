/**
 * Per-command payload types and runtime guards for the WebSocket command router.
 *
 * Validation approach (a): hand-written discriminated-union TypeScript types plus a
 * small runtime guard per command — NO new dependency. `client/package.json` ships no
 * schema library (no zod) and the validation here is a handful of shape/type checks per
 * command, so a runtime dependency is not justified.
 *
 * These guards run at the transport trust boundary (`handleExecuteCommand`) before a
 * payload can reach a controller that drives browser automation. They check the fields
 * each controller's `*Direct` method actually reads; extra fields are ignored. On
 * failure `validateCommandPayload` returns a human-readable reason string, and the
 * router replies with a structured `INVALID_PAYLOAD` error instead of forwarding the
 * payload.
 *
 * Community edition: only the core LinkedIn commands the community router dispatches
 * are typed and validated here.
 */

// --- Per-command payload types (one per command the router dispatches) ---

export interface SearchCommandPayload {
  jwtToken?: string;
  companyName?: string;
  companyRole?: string;
  companyLocation?: string;
  linkedinCredentialsCiphertext?: string;
  [key: string]: unknown;
}

export interface SendMessageCommandPayload {
  jwtToken?: string;
  recipientProfileId?: string;
  messageContent?: string;
  recipientName?: string;
  linkedinCredentialsCiphertext?: string;
  [key: string]: unknown;
}

export interface AddConnectionCommandPayload {
  jwtToken?: string;
  profileId?: string;
  profileUrl?: string;
  message?: string;
  linkedinCredentialsCiphertext?: string;
  [key: string]: unknown;
}

export interface FollowProfileCommandPayload {
  jwtToken?: string;
  profileId?: string;
  linkedinCredentialsCiphertext?: string;
  [key: string]: unknown;
}

export interface ProfileInitCommandPayload {
  jwtToken?: string;
  linkedinCredentialsCiphertext?: string;
  [key: string]: unknown;
}

export type AnyCommandPayload =
  | SearchCommandPayload
  | SendMessageCommandPayload
  | AddConnectionCommandPayload
  | FollowProfileCommandPayload
  | ProfileInitCommandPayload;

// --- Small runtime predicates ---

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/**
 * Per-command validators. Each returns null when the payload is structurally
 * acceptable, or a human-readable reason string describing the first violation.
 * Required-field enforcement is left to the controller, which already raises a
 * typed domain error; these guards reject only payloads that are the wrong
 * type/shape for a field the controller will read.
 */
const VALIDATORS: Record<string, (payload: Record<string, unknown>) => string | null> = {
  'linkedin:search': (p) => {
    if (!isOptionalString(p.jwtToken)) return 'jwtToken must be a string';
    if (!isOptionalString(p.companyName)) return 'companyName must be a string';
    if (!isOptionalString(p.companyRole)) return 'companyRole must be a string';
    if (!isOptionalString(p.companyLocation)) return 'companyLocation must be a string';
    if (!isOptionalString(p.linkedinCredentialsCiphertext))
      return 'linkedinCredentialsCiphertext must be a string';
    return null;
  },
  'linkedin:send-message': (p) => {
    if (!isOptionalString(p.jwtToken)) return 'jwtToken must be a string';
    if (!isOptionalString(p.recipientProfileId)) return 'recipientProfileId must be a string';
    if (!isOptionalString(p.messageContent)) return 'messageContent must be a string';
    if (!isOptionalString(p.recipientName)) return 'recipientName must be a string';
    if (!isOptionalString(p.linkedinCredentialsCiphertext))
      return 'linkedinCredentialsCiphertext must be a string';
    return null;
  },
  'linkedin:add-connection': (p) => {
    if (!isOptionalString(p.jwtToken)) return 'jwtToken must be a string';
    if (!isOptionalString(p.profileId)) return 'profileId must be a string';
    if (!isOptionalString(p.profileUrl)) return 'profileUrl must be a string';
    if (!isOptionalString(p.message)) return 'message must be a string';
    if (!isOptionalString(p.linkedinCredentialsCiphertext))
      return 'linkedinCredentialsCiphertext must be a string';
    return null;
  },
  'linkedin:follow-profile': (p) => {
    if (!isOptionalString(p.jwtToken)) return 'jwtToken must be a string';
    if (!isOptionalString(p.profileId)) return 'profileId must be a string';
    if (!isOptionalString(p.linkedinCredentialsCiphertext))
      return 'linkedinCredentialsCiphertext must be a string';
    return null;
  },
  'linkedin:profile-init': (p) => {
    if (!isOptionalString(p.jwtToken)) return 'jwtToken must be a string';
    if (!isOptionalString(p.linkedinCredentialsCiphertext))
      return 'linkedinCredentialsCiphertext must be a string';
    return null;
  },
};

/**
 * Validate an untrusted command payload at the transport boundary.
 *
 * @returns null when the payload is acceptable for the given command type, or a
 *   human-readable reason string when it is not (used as the `INVALID_PAYLOAD`
 *   error message). An unknown command type is rejected with `UNKNOWN_COMMAND` by
 *   the router before this is called, so an unrecognized type passes through here.
 */
export function validateCommandPayload(type: string, payload: unknown): string | null {
  if (!isPlainObject(payload)) {
    return 'payload must be an object';
  }
  const validator = VALIDATORS[type];
  if (!validator) {
    return null;
  }
  return validator(payload);
}
