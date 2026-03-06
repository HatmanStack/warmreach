import type { Connection } from '@/shared/types/index';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('WorkflowProgressService');

// =============================================================================
// INTERFACES
// =============================================================================

/**
 * Workflow progress state for message generation
 */
interface WorkflowProgressState {
  /** Current workflow phase */
  phase: 'idle' | 'preparing' | 'generating' | 'completed' | 'error' | 'stopped';
  /** Current connection being processed */
  currentConnection?: Connection;
  /** Index of current connection (0-based) */
  currentIndex: number;
  /** Total number of connections to process */
  totalConnections: number;
  /** Array of processed connection IDs */
  processedConnections: string[];
  /** Array of failed connection IDs */
  failedConnections: string[];
  /** Array of skipped connection IDs */
  skippedConnections: string[];
  /** Start time of the workflow */
  startTime?: number;
  /** Estimated time remaining in seconds */
  estimatedTimeRemaining?: number;
  /** Error message if workflow failed */
  errorMessage?: string;
}

/**
 * Workflow completion statistics
 */
interface WorkflowCompletionStats {
  /** Total connections processed */
  totalProcessed: number;
  /** Number of successful generations */
  successful: number;
  /** Number of failed generations */
  failed: number;
  /** Number of skipped connections */
  skipped: number;
  /** Total time taken in seconds */
  totalTime: number;
  /** Success rate percentage */
  successRate: number;
}

/**
 * Progress update callback function
 */
type ProgressUpdateCallback = (state: WorkflowProgressState) => void;

/**
 * Completion callback function
 */
type CompletionCallback = (stats: WorkflowCompletionStats) => void;

// =============================================================================
// WORKFLOW PROGRESS SERVICE
// =============================================================================

/**
 * Service for tracking and managing workflow progress during message generation
 *
 * This service handles progress tracking, connection processing state,
 * completion notifications, and workflow reset functionality.
 */
export class WorkflowProgressService {
  private progressState: WorkflowProgressState;
  private progressCallbacks: ProgressUpdateCallback[] = [];
  private completionCallbacks: CompletionCallback[] = [];

  constructor() {
    this.progressState = this.getInitialState();
  }

  /**
   * Get initial workflow state
   */
  private getInitialState(): WorkflowProgressState {
    return {
      phase: 'idle',
      currentIndex: 0,
      totalConnections: 0,
      processedConnections: [],
      failedConnections: [],
      skippedConnections: [],
    };
  }

  /**
   * Initialize workflow with connections to process
   *
   * @param connections - Array of connections to process
   */
  initializeWorkflow(connections: Connection[]): void {
    this.progressState = {
      ...this.getInitialState(),
      phase: 'preparing',
      totalConnections: connections.length,
      startTime: Date.now(),
    };

    this.notifyProgressUpdate();
  }

  /**
   * Start processing a specific connection
   *
   * @param connection - Connection being processed
   * @param index - Index of the connection in the workflow
   */
  startProcessingConnection(connection: Connection, index: number): void {
    this.progressState = {
      ...this.progressState,
      phase: 'generating',
      currentConnection: connection,
      currentIndex: index,
      estimatedTimeRemaining: this.calculateEstimatedTimeRemaining(),
    };

    this.notifyProgressUpdate();
  }

  /**
   * Mark connection as successfully processed
   *
   * @param connectionId - ID of the processed connection
   */
  markConnectionSuccess(connectionId: string): void {
    this.progressState = {
      ...this.progressState,
      processedConnections: [...this.progressState.processedConnections, connectionId],
    };

    this.checkWorkflowCompletion();
  }

  /**
   * Mark connection as failed
   *
   * @param connectionId - ID of the failed connection
   * @param errorMessage - Error message for the failure
   */
  markConnectionFailure(connectionId: string, errorMessage?: string): void {
    this.progressState = {
      ...this.progressState,
      failedConnections: [...this.progressState.failedConnections, connectionId],
      errorMessage,
    };

    this.checkWorkflowCompletion();
  }

  /**
   * Mark connection as skipped
   *
   * @param connectionId - ID of the skipped connection
   */
  markConnectionSkipped(connectionId: string): void {
    this.progressState = {
      ...this.progressState,
      skippedConnections: [...this.progressState.skippedConnections, connectionId],
    };

    this.checkWorkflowCompletion();
  }

  /**
   * Stop the workflow (user requested)
   */
  stopWorkflow(): void {
    this.progressState = {
      ...this.progressState,
      phase: 'stopped',
      currentConnection: undefined,
      estimatedTimeRemaining: undefined,
    };

    this.notifyProgressUpdate();
  }

  /**
   * Reset workflow to initial state
   */
  resetWorkflow(): void {
    this.progressState = this.getInitialState();
    this.notifyProgressUpdate();
  }

  /**
   * Get current workflow progress state
   */
  getProgressState(): WorkflowProgressState {
    return { ...this.progressState };
  }

  /**
   * Get current connection name being processed
   */
  getCurrentConnectionName(): string | undefined {
    if (!this.progressState.currentConnection) {
      return undefined;
    }

    const { first_name, last_name } = this.progressState.currentConnection;
    return `${first_name} ${last_name}`;
  }

  /**
   * Get progress percentage (0-100)
   */
  getProgressPercentage(): number {
    if (this.progressState.totalConnections === 0) {
      return 0;
    }

    const completed =
      this.progressState.processedConnections.length +
      this.progressState.failedConnections.length +
      this.progressState.skippedConnections.length;

    return Math.round((completed / this.progressState.totalConnections) * 100);
  }

  /**
   * Check if workflow is active (generating or preparing)
   */
  isWorkflowActive(): boolean {
    return this.progressState.phase === 'generating' || this.progressState.phase === 'preparing';
  }

  /**
   * Check if workflow is completed
   */
  isWorkflowCompleted(): boolean {
    return this.progressState.phase === 'completed';
  }

  /**
   * Check if workflow has errors
   */
  hasWorkflowErrors(): boolean {
    return this.progressState.failedConnections.length > 0;
  }

  /**
   * Subscribe to progress updates
   *
   * @param callback - Function to call on progress updates
   * @returns Unsubscribe function
   */
  onProgressUpdate(callback: ProgressUpdateCallback): () => void {
    this.progressCallbacks.push(callback);

    return () => {
      const index = this.progressCallbacks.indexOf(callback);
      if (index > -1) {
        this.progressCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Subscribe to completion notifications
   *
   * @param callback - Function to call on workflow completion
   * @returns Unsubscribe function
   */
  onWorkflowComplete(callback: CompletionCallback): () => void {
    this.completionCallbacks.push(callback);

    return () => {
      const index = this.completionCallbacks.indexOf(callback);
      if (index > -1) {
        this.completionCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Calculate estimated time remaining based on current progress
   */
  private calculateEstimatedTimeRemaining(): number | undefined {
    if (!this.progressState.startTime) {
      return undefined;
    }

    const completedConnections =
      this.progressState.processedConnections.length +
      this.progressState.failedConnections.length +
      this.progressState.skippedConnections.length;

    if (completedConnections === 0) {
      return undefined;
    }

    const elapsed = Date.now() - this.progressState.startTime;
    const avgTimePerConnection = elapsed / completedConnections;
    const remaining = this.progressState.totalConnections - completedConnections;

    return Math.round((avgTimePerConnection * remaining) / 1000);
  }

  /**
   * Check if workflow is completed and notify callbacks
   */
  private checkWorkflowCompletion(): void {
    const totalProcessed =
      this.progressState.processedConnections.length +
      this.progressState.failedConnections.length +
      this.progressState.skippedConnections.length;

    if (totalProcessed >= this.progressState.totalConnections) {
      this.progressState = {
        ...this.progressState,
        phase: 'completed',
        currentConnection: undefined,
        estimatedTimeRemaining: undefined,
      };

      this.notifyProgressUpdate();
      this.notifyCompletion();
    } else {
      this.notifyProgressUpdate();
    }
  }

  /**
   * Notify all progress update callbacks
   */
  private notifyProgressUpdate(): void {
    this.progressCallbacks.forEach((callback) => {
      try {
        callback(this.getProgressState());
      } catch (error) {
        logger.error('Error in progress update callback', { error });
      }
    });
  }

  /**
   * Notify all completion callbacks
   */
  private notifyCompletion(): void {
    const stats = this.getCompletionStats();

    this.completionCallbacks.forEach((callback) => {
      try {
        callback(stats);
      } catch (error) {
        logger.error('Error in completion callback', { error });
      }
    });
  }

  /**
   * Get workflow completion statistics
   */
  private getCompletionStats(): WorkflowCompletionStats {
    const successful = this.progressState.processedConnections.length;
    const failed = this.progressState.failedConnections.length;
    const skipped = this.progressState.skippedConnections.length;
    const totalProcessed = successful + failed + skipped;

    const totalTime = this.progressState.startTime
      ? Math.round((Date.now() - this.progressState.startTime) / 1000)
      : 0;

    const successRate = totalProcessed > 0 ? Math.round((successful / totalProcessed) * 100) : 0;

    return {
      totalProcessed,
      successful,
      failed,
      skipped,
      totalTime,
      successRate,
    };
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

// Interfaces are already exported above with their declarations
