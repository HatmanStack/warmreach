import type {
  BatchProgressUpdate,
  HealingParams,
  ListCreationProgressUpdate,
  ListCreationResumeParams,
  ListCreationState,
  ProfileInitState,
  ProgressSummary,
} from '../types/profileInit.js';

/**
 * Arguments accepted by {@link ProfileInitStateManager.buildInitialState}.
 * Everything the state carries is optional here; the builder supplies defaults
 * and passes any extra keys through untouched.
 */
export type ProfileInitParams = ProfileInitState;

/** Master-index shape read by {@link createListCreationHealingState}. */
interface MasterIndexFiles {
  files?: Record<string, string[] | undefined>;
}

export class ProfileInitStateManager {
  static buildInitialState({
    searchName,
    searchPassword,
    credentialsCiphertext,
    jwtToken,
    recursionCount = 0,
    healPhase = null,
    healReason = null,
    currentProcessingList = null,
    currentBatch = 0,
    currentIndex = 0,
    completedBatches = [],
    masterIndexFile = null,
    batchSize = 100,
    totalConnections = { all: 0, pending: 0, sent: 0 },
    userProfileId = null,
    sessionId = null,
    ...opts
  }: ProfileInitParams): ProfileInitState {
    return {
      searchName,
      searchPassword,
      credentialsCiphertext,
      jwtToken,
      recursionCount,
      healPhase,
      healReason,
      currentProcessingList,
      currentBatch,
      currentIndex,
      completedBatches,
      masterIndexFile,
      batchSize,
      totalConnections,
      userProfileId,
      sessionId,
      timestamp: new Date().toISOString(),
      ...opts,
    };
  }

  /**
   * Build state for healing/recovery scenarios
   * @param existingState - Current state
   * @param healingParams - Healing parameters
   * @returns Updated state for healing
   */
  static buildHealingState(
    existingState: ProfileInitState,
    healingParams: HealingParams
  ): ProfileInitState {
    return {
      ...existingState,
      recursionCount: (existingState.recursionCount || 0) + 1,
      healPhase: healingParams.healPhase || 'profile-init',
      healReason: healingParams.healReason || 'Unknown error',
      currentProcessingList:
        healingParams.currentProcessingList || existingState.currentProcessingList,
      currentBatch: healingParams.currentBatch || existingState.currentBatch,
      currentIndex: healingParams.currentIndex || existingState.currentIndex,
      completedBatches: healingParams.completedBatches || existingState.completedBatches,
      masterIndexFile: healingParams.masterIndexFile || existingState.masterIndexFile,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Update state with batch processing progress
   * @param state - Current state
   * @param progress - Progress update
   * @returns Updated state
   */
  static updateBatchProgress(
    state: ProfileInitState,
    progress: BatchProgressUpdate
  ): ProfileInitState {
    return {
      ...state,
      currentProcessingList: progress.currentProcessingList || state.currentProcessingList,
      currentBatch:
        progress.currentBatch !== undefined ? progress.currentBatch : state.currentBatch,
      currentIndex:
        progress.currentIndex !== undefined ? progress.currentIndex : state.currentIndex,
      completedBatches: progress.completedBatches || state.completedBatches,
      totalConnections: progress.totalConnections || state.totalConnections,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Validate required state fields
   * @param state - State to validate
   * @throws {Error} If validation fails
   */
  static validateState(state: ProfileInitState): void {
    const hasPlain = !!(state.searchName && state.searchPassword);
    const hasCipher =
      typeof state.credentialsCiphertext === 'string' &&
      state.credentialsCiphertext.startsWith('sealbox_x25519:b64:');
    if (!hasPlain && !hasCipher) {
      throw new Error(
        'Missing required credentials: provide searchName/searchPassword or credentialsCiphertext'
      );
    }
    if (!state.jwtToken) {
      throw new Error('Missing required state field: jwtToken');
    }

    // Validate batch processing fields if present
    if (state.currentBatch !== undefined && state.currentBatch < 0) {
      throw new Error('currentBatch must be non-negative');
    }

    if (state.currentIndex !== undefined && state.currentIndex < 0) {
      throw new Error('currentIndex must be non-negative');
    }

    if (state.batchSize !== undefined && state.batchSize <= 0) {
      throw new Error('batchSize must be positive');
    }

    // Validate connection list type - updated for new connection types
    const validConnectionTypes = ['ally', 'incoming', 'outgoing'];
    if (
      state.currentProcessingList !== undefined &&
      state.currentProcessingList !== null &&
      state.currentProcessingList !== '' &&
      !validConnectionTypes.includes(state.currentProcessingList)
    ) {
      throw new Error(
        `Invalid currentProcessingList: ${state.currentProcessingList}. Must be one of: ${validConnectionTypes.join(', ')}`
      );
    }
  }

  /**
   * Check if state indicates a healing scenario
   * @param state - State to check
   * @returns True if healing is in progress
   */
  static isHealingState(state: ProfileInitState): boolean {
    return !!(state.healPhase && state.healReason);
  }

  /**
   * Check if state indicates resumption from a previous session
   * @param state - State to check
   * @returns True if resuming
   */
  static isResumingState(state: ProfileInitState): boolean {
    return !!(
      state.masterIndexFile ||
      (state.currentBatch ?? 0) > 0 ||
      (state.currentIndex ?? 0) > 0 ||
      (state.completedBatches && state.completedBatches.length > 0)
    );
  }

  /**
   * Get progress summary from state
   * @param state - Current state
   * @returns Progress summary
   */
  static getProgressSummary(state: ProfileInitState): ProgressSummary {
    const totalExpectedConnections = (
      Object.values(state.totalConnections || {}) as number[]
    ).reduce((sum: number, count: number) => sum + count, 0);
    const completedBatches = state.completedBatches ? state.completedBatches.length : 0;
    const currentBatch = state.currentBatch || 0;
    const currentIndex = state.currentIndex || 0;
    const batchSize = state.batchSize || 100;

    // Estimate progress based on completed batches and current position
    const estimatedProcessed = completedBatches * batchSize + currentIndex;
    const progressPercentage =
      totalExpectedConnections > 0
        ? Math.min(100, (estimatedProcessed / totalExpectedConnections) * 100)
        : 0;

    return {
      currentProcessingList: state.currentProcessingList || 'all',
      currentBatch,
      currentIndex,
      completedBatches,
      totalExpectedConnections,
      estimatedProcessed,
      progressPercentage: Math.round(progressPercentage * 100) / 100,
      isHealing: this.isHealingState(state),
      isResuming: this.isResumingState(state),
      recursionCount: state.recursionCount || 0,
    };
  }

  /**
   * Create state for specific healing scenarios
   * @param baseState - Base state
   * @param healPhase - Healing phase identifier
   * @param healReason - Reason for healing
   * @param additionalParams - Additional healing parameters
   * @returns Healing state
   */
  static createHealingState(
    baseState: ProfileInitState,
    healPhase: string,
    healReason: string,
    additionalParams: HealingParams = {}
  ): ProfileInitState {
    return this.buildHealingState(baseState, {
      healPhase,
      healReason,
      ...additionalParams,
    });
  }

  /**
   * Create healing state for list creation scenarios
   * @param baseState - Base state
   * @param connectionType - Type of connection being collected (ally, incoming, outgoing)
   * @param expansionAttempt - Current expansion attempt number
   * @param currentFileIndex - Current file index being written
   * @param masterIndex - Current master index state
   * @param healReason - Reason for healing
   * @returns List creation healing state
   */
  static createListCreationHealingState(
    baseState: ProfileInitState,
    connectionType: string,
    expansionAttempt: number,
    currentFileIndex: number,
    masterIndex: MasterIndexFiles,
    healReason: string
  ): ProfileInitState {
    return {
      ...baseState,
      recursionCount: (baseState.recursionCount || 0) + 1,
      healPhase: 'list-creation',
      healReason: healReason,
      currentProcessingList: connectionType,
      listCreationState: {
        connectionType: connectionType,
        expansionAttempt: expansionAttempt,
        currentFileIndex: currentFileIndex,
        masterIndexFile: baseState.masterIndexFile,
        lastSavedFile: masterIndex?.files?.[`${connectionType}Connections`]?.slice(-1)?.[0] || null,
        resumeFromExpansion: true,
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Update state with list creation progress
   * @param state - Current state
   * @param progress - Progress update
   * @returns Updated state
   */
  static updateListCreationProgress(
    state: ProfileInitState,
    progress: ListCreationProgressUpdate
  ): ProfileInitState {
    const listCreationState: ListCreationState = state.listCreationState ?? {};
    return {
      ...state,
      currentProcessingList: progress.connectionType || state.currentProcessingList,
      listCreationState: {
        ...listCreationState,
        expansionAttempt:
          progress.expansionAttempt !== undefined
            ? progress.expansionAttempt
            : listCreationState.expansionAttempt,
        currentFileIndex:
          progress.currentFileIndex !== undefined
            ? progress.currentFileIndex
            : listCreationState.currentFileIndex,
        lastSavedFile: progress.lastSavedFile || listCreationState.lastSavedFile,
        totalLinksCollected: progress.totalLinksCollected || listCreationState.totalLinksCollected,
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Check if state indicates list creation healing
   * @param state - State to check
   * @returns True if list creation healing is in progress
   */
  static isListCreationHealingState(state: ProfileInitState): boolean {
    return state.healPhase === 'list-creation' && !!state.listCreationState;
  }

  /**
   * Get list creation resume parameters from healing state
   * @param state - Healing state
   * @returns Resume parameters for list creation
   */
  static getListCreationResumeParams(state: ProfileInitState): ListCreationResumeParams | null {
    if (!this.isListCreationHealingState(state)) {
      return null;
    }
    // isListCreationHealingState guarantees listCreationState is set.
    const listCreationState = state.listCreationState as ListCreationState;

    return {
      connectionType: listCreationState.connectionType,
      expansionAttempt: listCreationState.expansionAttempt || 0,
      currentFileIndex: listCreationState.currentFileIndex || 0,
      masterIndexFile: listCreationState.masterIndexFile,
      lastSavedFile: listCreationState.lastSavedFile,
      resumeFromExpansion: listCreationState.resumeFromExpansion || false,
      totalLinksCollected: listCreationState.totalLinksCollected || 0,
    };
  }

  /**
   * Reset state for fresh start while preserving authentication
   * @param state - Current state
   * @returns Reset state
   */
  static resetProcessingState(state: ProfileInitState): ProfileInitState {
    return {
      ...state,
      currentProcessingList: 'ally',
      currentBatch: 0,
      currentIndex: 0,
      completedBatches: [],
      masterIndexFile: null,
      healPhase: null,
      healReason: null,
      listCreationState: null,
      timestamp: new Date().toISOString(),
    };
  }
}
