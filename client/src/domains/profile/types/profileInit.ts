/**
 * Shared profile-initialization state shapes.
 *
 * `ProfileInitState` used to live in `profileInitService.ts`, which imports
 * `ProfileInitStateManager`; hoisting it here lets the state manager describe
 * the state it builds without a module cycle. `profileInitService` re-exports
 * it, so existing importers are unaffected.
 */

/**
 * Per-connection-type totals carried on the init state.
 *
 * The producer (`profileInitService.processConnectionLists`) writes
 * `ally`/`incoming`/`outgoing`; `ProfileInitStateManager.buildInitialState`
 * seeds a different vocabulary. Nothing reads a member by name — the only
 * consumer sums the values — so the map keeps the known keys as hints and
 * accepts others.
 */
export interface ConnectionTotals {
  ally?: number;
  incoming?: number;
  outgoing?: number;
  [key: string]: number | undefined;
}

/** State threaded through a profile-initialization run. */
export interface ProfileInitState {
  requestId?: string;
  recursionCount?: number;
  healPhase?: string | null;
  healReason?: string | null;
  currentProcessingList?: string | null;
  currentBatch?: number;
  currentIndex?: number;
  jwtToken?: string;
  searchName?: string | null;
  searchPassword?: string | null;
  credentialsCiphertext?: string;
  masterIndexFile?: string | null;
  batchSize?: number;
  userProfileId?: string | null;
  sessionId?: string | null;
  timestamp?: string;
  totalConnections?: ConnectionTotals;
  completedBatches?: number[];
  lastError?: {
    connectionType: string;
    message: string;
    timestamp: string;
  };
  listCreationState?: ListCreationState | null;
  /**
   * Consent flag from the profile-init payload. When true (and a collector is
   * injected), each scraped contact's mutual connections are collected and
   * persisted as private adjacency edges. Absent/false => no collection.
   */
  collectMutuals?: boolean;
  [key: string]: unknown;
}

/** Sub-state describing an interrupted connection-list build. */
export interface ListCreationState {
  connectionType?: string;
  expansionAttempt?: number;
  currentFileIndex?: number;
  masterIndexFile?: string | null;
  lastSavedFile?: string | null;
  resumeFromExpansion?: boolean;
  totalLinksCollected?: number;
  [key: string]: unknown;
}

/**
 * Overrides applied when a run is restarted after a recoverable failure.
 * Every field is optional: an absent field means "keep what the existing state
 * already has".
 */
export interface HealingParams {
  healPhase?: string;
  healReason?: string;
  currentProcessingList?: string | null;
  currentBatch?: number;
  currentIndex?: number;
  completedBatches?: number[];
  masterIndexFile?: string | null;
  recursionCount?: number;
  timestamp?: string;
  [key: string]: unknown;
}

/** Batch-processing progress applied on top of an existing state. */
export interface BatchProgressUpdate {
  currentProcessingList?: string | null;
  currentBatch?: number;
  currentIndex?: number;
  completedBatches?: number[];
  totalConnections?: ConnectionTotals;
}

/** Progress applied to an in-flight connection-list build. */
export interface ListCreationProgressUpdate {
  connectionType?: string;
  expansionAttempt?: number;
  currentFileIndex?: number;
  lastSavedFile?: string | null;
  totalLinksCollected?: number;
}

/** Derived, read-only view of how far a run has progressed. */
export interface ProgressSummary {
  currentProcessingList: string;
  currentBatch: number;
  currentIndex: number;
  completedBatches: number;
  totalExpectedConnections: number;
  estimatedProcessed: number;
  progressPercentage: number;
  isHealing: boolean;
  isResuming: boolean;
  recursionCount: number;
}

/** Parameters needed to resume an interrupted connection-list build. */
export interface ListCreationResumeParams {
  connectionType?: string;
  expansionAttempt: number;
  currentFileIndex: number;
  masterIndexFile?: string | null;
  lastSavedFile?: string | null;
  resumeFromExpansion: boolean;
  totalLinksCollected: number;
}
