/**
 * @fileoverview Core TypeScript interfaces and types for the Connection Management System
 *
 * This file contains the essential types and interfaces used throughout
 * the connection management system. It provides type safety for components, services,
 * and API interactions while maintaining consistency across the application.
 *
 * @author Connection Management System
 * @version 2.0.0
 */

// =============================================================================
// BRANDED TYPES - Nominal typing for ID safety
// =============================================================================

/**
 * Branded type helper for compile-time nominal typing.
 * Prevents accidental mixing of string IDs from different domains.
 */
declare const __brand: unique symbol;
type Brand<B> = { [__brand]: B };

/** Branded type for Connection IDs (base64 encoded LinkedIn URL) */
export type ConnectionId = string & Brand<'ConnectionId'>;

/** Branded type for User IDs (Cognito sub) */
export type UserId = string & Brand<'UserId'>;

/** Branded type for Message IDs */
export type MessageId = string & Brand<'MessageId'>;

/** Branded type for LinkedIn Profile IDs */
export type ProfileId = string & Brand<'ProfileId'>;

// =============================================================================
// DISCRIMINATED UNION TYPES - For type-safe API responses
// =============================================================================

/**
 * Discriminated union for API operation results.
 * Forces callers to check success before accessing data.
 */
export type ApiResult<T, E = ApiErrorInfo> =
  | { success: true; data: T }
  | { success: false; error: E };

/**
 * Discriminated union for async operation status.
 * Useful for React Query and loading states.
 */
export type AsyncStatus<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: Error };

// =============================================================================
// CORE DATA INTERFACES
// =============================================================================

/**
 * Represents a LinkedIn connection with all associated metadata
 *
 * @interface Connection
 * @description Core interface for connection data retrieved from DynamoDB.
 * Contains profile information, relationship status, and interaction history.
 */
export interface Connection {
  /** Unique identifier for the connection (base64 encoded LinkedIn URL) */
  id: string;

  /** First name of the connection */
  first_name: string;

  /** Last name of the connection */
  last_name: string;

  /** Current job position/title */
  position: string;

  /** Current company/organization */
  company: string;

  /** Geographic location (optional) */
  location?: string;

  /** LinkedIn headline/professional summary (optional) */
  headline?: string;

  /** Recent activity or summary text (optional) */
  recent_activity?: string;

  /** Array of common interests or skills (optional) */
  common_interests?: string[];

  /** Number of messages exchanged (optional) */
  messages?: number;

  /** Date when connection was added to system (ISO string, optional) */
  date_added?: string;

  /** Original LinkedIn profile URL (optional) */
  linkedin_url?: string;

  /** Array of tags for categorization (optional) */
  tags?: string[];

  /** Summary of last action taken with this connection (optional) */
  last_action_summary?: string;

  /** Alternative field for last activity summary (optional) */
  last_activity_summary?: string;

  /** Current relationship status with the connection */
  status: ConnectionStatus;

  /** Conversion likelihood classification for 'possible' connections (enum string, optional) */
  conversion_likelihood?: ConversionLikelihood;

  /** Profile picture URL from LinkedIn CDN (optional, may expire) */
  profile_picture_url?: string;

  /** Array of message history (optional) */
  message_history?: Message[];

  /** Flag indicating if this is demo/fake data (optional) */
  isFakeData?: boolean;
}

/**
 * Represents a message in the conversation history
 *
 * @interface Message
 * @description Individual message within a connection's message history.
 * Contains content, metadata, and sender information.
 */
export interface Message {
  /** Unique identifier for the message */
  id: string;

  /** Message content/text */
  content: string;

  /** Timestamp when message was sent (ISO string) */
  timestamp: string;

  /** Who sent the message */
  sender: MessageSender;
}

/**
 * Filter criteria for connection queries
 *
 * @interface ConnectionFilters
 * @description Used to filter connections by various criteria in queries and UI components.
 */
export interface ConnectionFilters {
  /** Filter by connection status (optional) */
  status?: ConnectionStatus | 'all';

  /** Filter by specific tags (optional) */
  tags?: string[];

  /** Filter by company name (optional) */
  company?: string;

  /** Filter by location (optional) */
  location?: string;

  /** Search term for name/position/company (optional) */
  searchTerm?: string;

  /** Filter by conversion likelihood values (optional) */
  conversionLikelihood?: ConversionLikelihood | ConversionLikelihood[] | 'all';
}

/**
 * User profile interface for the application
 *
 * @interface UserProfile
 * @description Contains all user profile information including LinkedIn data and AI-generated content.
 */
export interface UserProfile {
  /** Unique user identifier */
  user_id?: string;

  /** LinkedIn profile identifier */
  linkedin_id?: string;

  /** User's first name */
  first_name?: string;

  /** User's last name */
  last_name?: string;

  /** User's email address */
  email?: string;

  /** Professional headline */
  headline?: string;

  /** LinkedIn profile URL */
  profile_url?: string;

  /** Profile picture URL */
  profile_picture_url?: string;

  /** Geographic location */
  location?: string;

  /** Professional summary */
  summary?: string;

  /** Industry classification */
  industry?: string;

  /** Current job position */
  current_position?: string;

  /** Current company */
  company?: string;

  /** Array of interests */
  interests?: string[];

  /** Encrypted LinkedIn credentials */
  linkedin_credentials?: string;

  /** Unpublished post content */
  unpublished_post_content?: string;

  /** AI-generated content ideas */
  ai_generated_ideas?: string[];

  /** AI-generated research content */
  ai_generated_research?: string;

  /** AI-generated post hook */
  ai_generated_post_hook?: string;

  /** AI-generated post reasoning */
  ai_generated_post_reasoning?: string;

  /** Profile creation timestamp */
  created_at?: string;

  /** Profile last update timestamp */
  updated_at?: string;
}

// =============================================================================
// ENUMS AND UNION TYPES
// =============================================================================

/**
 * Valid connection status values
 *
 * @type ConnectionStatus
 * @description Represents the current relationship status between user and connection.
 * Maps to database status values and determines display behavior.
 */
export type ConnectionStatus =
  | 'possible' // Potential connection not yet contacted
  | 'incoming' // Connection request received from them
  | 'outgoing' // Connection request sent to them
  | 'ally' // Established connection
  | 'processed'; // Removed from possible connections

/**
 * Message sender types
 *
 * @type MessageSender
 * @description Identifies who sent a particular message in the conversation.
 */
export type MessageSender = 'user' | 'connection';

/**
 * Status picker filter values
 *
 * @type StatusValue
 * @description Valid values for the status picker component filter.
 * Includes 'all' for showing all connection types.
 */
export type StatusValue = 'all' | 'incoming' | 'outgoing' | 'ally';

/**
 * Conversion likelihood classification
 *
 * @type ConversionLikelihood
 * @description Simple three-tier classification for conversion potential.
 * Replaces percentage-based scoring (0-100) with clear categories.
 * - high: Complete profile + recent + no prior attempts
 * - medium: Partial data or older profile
 * - low: Incomplete profile or many attempts
 */
export type ConversionLikelihood = 'high' | 'medium' | 'low';

/**
 * Error severity levels
 *
 * @type ErrorSeverity
 * @description Categorizes errors by their impact and urgency for user feedback.
 */
export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Toast notification variants
 *
 * @type ToastVariant
 * @description Valid variants for toast notifications matching UI component expectations.
 */
export type ToastVariant = 'default' | 'destructive' | 'success' | 'warning';

// =============================================================================
// VALIDATION AND ERROR HANDLING TYPES
// =============================================================================

/**
 * Validation result interface
 *
 * @interface ValidationResult
 * @description Contains validation results with errors, warnings, and sanitized data
 */
export interface ValidationResult {
  /** Whether the validation passed */
  isValid: boolean;

  /** Array of validation errors */
  errors: string[];

  /** Array of validation warnings */
  warnings?: string[];

  /** Sanitized data if sanitization was performed */
  sanitizedData?: unknown;
}

/**
 * Transform options for validation and sanitization
 *
 * @interface TransformOptions
 * @description Options for data transformation during validation
 */
export interface TransformOptions {
  /** Whether to attempt sanitization of invalid data */
  sanitize?: boolean;

  /** Whether to include warnings in results */
  includeWarnings?: boolean;
}

/**
 * Error recovery action interface
 *
 * @interface ErrorRecoveryAction
 * @description Defines an action that can be taken to recover from an error
 */
export interface ErrorRecoveryAction {
  /** Display label for the action */
  label: string;

  /** Function to execute when action is selected */
  action: () => void;

  /** Whether this is the primary/recommended action */
  primary?: boolean;

  /** Optional description of what the action does */
  description?: string;
}

/**
 * User-friendly error information
 *
 * @interface UserErrorInfo
 * @description Contains user-friendly error information with recovery options
 */
export interface UserErrorInfo {
  /** User-friendly error message */
  userMessage: string;

  /** Technical error message for debugging */
  technicalMessage: string;

  /** Error severity level */
  severity: ErrorSeverity;

  /** Whether the operation can be retried */
  retryable: boolean;

  /** Available recovery actions */
  recoveryActions: ErrorRecoveryAction[];

  /** Timestamp when error occurred */
  timestamp: string;
}

/**
 * Error recovery options for workflow errors
 *
 * @interface ErrorRecoveryOptions
 * @description Defines which recovery options are available for a specific error
 */
export interface ErrorRecoveryOptions {
  /** Allow retry of failed operation */
  retry: boolean;

  /** Skip current connection and continue */
  skip: boolean;

  /** Stop entire process */
  stop: boolean;

  /** Use fallback message generation */
  fallback: boolean;
}

/**
 * Workflow error for message generation process
 *
 * @interface WorkflowError
 * @description Contains error information specific to message generation workflow
 */
export interface WorkflowError {
  /** Type of error that occurred */
  type: 'network' | 'api' | 'validation' | 'authentication' | 'rate_limit' | 'unknown';

  /** Error message */
  message: string;

  /** Connection ID where error occurred (optional) */
  connectionId?: string;

  /** Connection name for display (optional) */
  connectionName?: string;

  /** Available recovery options */
  recoveryOptions: ErrorRecoveryOptions;

  /** Number of retry attempts (optional) */
  retryCount?: number;

  /** Timestamp when error occurred */
  timestamp: string;
}

/**
 * Progress state for workflow operations
 *
 * @interface ProgressState
 * @description Tracks progress of multi-step operations like message generation
 */
export interface ProgressState {
  /** Current step number */
  current: number;

  /** Total number of steps */
  total: number;

  /** Current connection name being processed (optional) */
  currentConnectionName?: string;

  /** Current phase of the operation */
  phase: 'preparing' | 'generating' | 'waiting_approval' | 'completed' | 'error';

  /** Estimated time remaining in seconds (optional) */
  estimatedTimeRemaining?: number;
}

/**
 * Loading state for UI components
 *
 * @interface LoadingState
 * @description Manages loading indicators and progress displays
 */
export interface LoadingState {
  /** Whether a loading operation is in progress */
  isLoading: boolean;

  /** Loading message to display (optional) */
  message?: string;

  /** Progress percentage 0-100 (optional) */
  progress?: number;

  /** Whether the operation can be cancelled (optional) */
  canCancel?: boolean;
}

// =============================================================================
// API RESPONSE INTERFACES
// =============================================================================

/**
 * Standard API response wrapper from Lambda functions
 *
 * @interface ApiResponse
 * @template T The type of the response body data
 * @description Wraps all API responses with consistent status and body structure.
 */
export interface ApiResponse<T = unknown> {
  /** HTTP status code */
  statusCode: number;

  /** Response payload */
  body: T;

  /** Optional error message for failed requests */
  error?: string;
}

/**
 * Search response from LinkedIn search operations
 *
 * @interface SearchResponse
 * @description Response format for LinkedIn search results.
 */
export interface SearchResponse {
  /** Array of search result strings */
  response: string[];
}

// =============================================================================
// ERROR HANDLING INTERFACES
// =============================================================================

/**
 * Structured error information for API errors
 *
 * @interface ApiErrorInfo
 * @description Contains all information needed to create an ApiError instance.
 */
export interface ApiErrorInfo {
  /** Human-readable error message */
  message: string;

  /** HTTP status code (optional) */
  status?: number;

  /** Error code identifier (optional) */
  code?: string;
}

// =============================================================================
// COMPONENT PROP INTERFACES
// =============================================================================

/**
 * Props for ConnectionCard component
 *
 * @interface ConnectionCardProps
 * @description Type-safe props for the main connection card component.
 */
export interface ConnectionCardProps {
  /** Connection data to display */
  connection: Connection;

  /** Whether this card is currently selected */
  isSelected?: boolean;

  /** Whether this is a new connection card variant */
  isNewConnection?: boolean;

  /** Callback when card is selected */
  onSelect?: (connectionId: string) => void;

  /** Callback for new connection card clicks */
  onNewConnectionClick?: (connection: Connection) => void;

  /** Callback when a tag is clicked */
  onTagClick?: (tag: string) => void;

  /** Callback when message count is clicked */
  onMessageClick?: (connection: Connection) => void;

  /** Array of currently active/selected tags */
  activeTags?: string[];

  /** Additional CSS classes */
  className?: string;

  /** Whether to show checkbox for connection selection */
  showCheckbox?: boolean;

  /** Whether the checkbox is enabled (only for ally status) */
  isCheckboxEnabled?: boolean;

  /** Whether the checkbox is checked */
  isChecked?: boolean;

  /** Callback when checkbox state changes */
  onCheckboxChange?: (connectionId: string, checked: boolean) => void;
}

/**
 * Props for NewConnectionCard component
 *
 * @interface NewConnectionCardProps
 * @description Type-safe props for the simplified new connection card component.
 */
export interface NewConnectionCardProps {
  /** Connection data to display (must have status 'possible') */
  connection: Connection;

  /** Callback when status-changing actions occur (remove/connect) */
  onRemove?: (connectionId: string, newStatus: ConnectionStatus) => void;

  /** Callback when card is selected */
  onSelect?: (connection: Connection) => void;

  /** Callback when a tag is clicked */
  onTagClick?: (tag: string) => void;

  /** Array of currently active/selected tags */
  activeTags?: string[];

  /** Additional CSS classes */
  className?: string;
}

/**
 * Props for StatusPicker component
 *
 * @interface StatusPickerProps
 * @description Type-safe props for the connection status filter component.
 */
export interface StatusPickerProps {
  /** Currently selected status filter */
  selectedStatus: StatusValue;

  /** Callback when status selection changes */
  onStatusChange: (status: StatusValue) => void;

  /** Connection counts for each status type */
  connectionCounts: ConnectionCounts;

  /** Additional CSS classes */
  className?: string;
}

/**
 * Props for MessageModal component
 *
 * @interface MessageModalProps
 * @description Type-safe props for the message history modal component.
 */
export interface MessageModalProps {
  /** Whether the modal is open */
  isOpen: boolean;

  /** Connection whose messages to display */
  connection: Connection;

  /** Callback to close the modal */
  onClose: () => void;

  /** Callback to send a new message (optional) */
  onSendMessage?: (message: string) => Promise<void>;

  /** Whether messages are currently loading */
  isLoadingMessages?: boolean;

  /** Error message if message loading failed */
  messagesError?: string | null;

  /** Pre-populated message content for generation workflow */
  prePopulatedMessage?: string;

  /** Whether the content is AI-generated */
  isGeneratedContent?: boolean;

  /** Callback for approving message and moving to next connection */
  onApproveAndNext?: () => void;

  /** Callback for skipping current connection */
  onSkipConnection?: () => void;

  /** Whether to show generation workflow controls */
  showGenerationControls?: boolean;

  /** Callback to retry loading messages */
  onRetryLoadMessages?: () => void;

  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// UTILITY AND HELPER INTERFACES
// =============================================================================

/**
 * Connection counts by status type
 *
 * @interface ConnectionCounts
 * @description Aggregated counts of connections by their status for display in UI components.
 */
export interface ConnectionCounts {
  /** Number of incoming connection requests */
  incoming: number;

  /** Number of outgoing connection requests */
  outgoing: number;

  /** Number of established connections */
  ally: number;

  /** Total number of connections across all statuses */
  total: number;

  /** Number of possible connections (optional) */
  possible?: number;
}

// Export type guards and validation functions
export * from './guards';
export * from './validators';
