import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowProgressService } from './workflowProgressService';
import { buildConnection } from '@/test-utils';

describe('WorkflowProgressService', () => {
  let service: WorkflowProgressService;

  const mockConnections = [
    buildConnection({ id: 'c1', first_name: 'John', last_name: 'Doe' }),
    buildConnection({ id: 'c2', first_name: 'Jane', last_name: 'Smith' }),
  ];

  beforeEach(() => {
    service = new WorkflowProgressService();
    vi.clearAllMocks();
  });

  describe('initializeWorkflow', () => {
    it('should set up connection tracking', () => {
      service.initializeWorkflow(mockConnections);
      const state = service.getProgressState();
      expect(state.totalConnections).toBe(2);
      expect(state.phase).toBe('preparing');
    });
  });

  describe('startProcessingConnection', () => {
    it('should update current connection and phase', () => {
      service.initializeWorkflow(mockConnections);
      service.startProcessingConnection(mockConnections[0], 0);
      const state = service.getProgressState();
      expect(state.currentConnection?.id).toBe('c1');
      expect(service.getCurrentConnectionName()).toBe('John Doe');
      expect(state.phase).toBe('generating');
    });
  });

  describe('markConnectionSuccess', () => {
    it('should add to processed connections', () => {
      service.initializeWorkflow(mockConnections);
      service.markConnectionSuccess('c1');
      const state = service.getProgressState();
      expect(state.processedConnections).toContain('c1');
    });
  });

  describe('markConnectionFailure', () => {
    it('should add to failed connections with error message', () => {
      service.initializeWorkflow(mockConnections);
      service.markConnectionFailure('c1', 'Network timeout');
      const state = service.getProgressState();
      expect(state.failedConnections).toContain('c1');
      expect(state.errorMessage).toBe('Network timeout');
    });
  });

  describe('markConnectionSkipped', () => {
    it('should add to skipped connections', () => {
      service.initializeWorkflow(mockConnections);
      service.markConnectionSkipped('c1');
      const state = service.getProgressState();
      expect(state.skippedConnections).toContain('c1');
    });
  });

  describe('getProgressPercentage', () => {
    it('should return 0 with no connections', () => {
      expect(service.getProgressPercentage()).toBe(0);
    });

    it('should calculate percentage correctly', () => {
      service.initializeWorkflow(mockConnections);
      service.markConnectionSuccess('c1');
      expect(service.getProgressPercentage()).toBe(50);
    });

    it('should include skipped in percentage', () => {
      service.initializeWorkflow(mockConnections);
      service.markConnectionSkipped('c1');
      expect(service.getProgressPercentage()).toBe(50);
    });

    it('should return 100 when all complete', () => {
      service.initializeWorkflow([mockConnections[0]]);
      service.markConnectionSuccess('c1');
      expect(service.getProgressPercentage()).toBe(100);
    });
  });

  describe('auto-completion', () => {
    it('should set phase to completed when all connections processed', () => {
      service.initializeWorkflow([mockConnections[0]]);
      service.markConnectionSuccess('c1');
      expect(service.getProgressState().phase).toBe('completed');
    });

    it('should complete with mixed success/failure/skipped', () => {
      service.initializeWorkflow(mockConnections);
      service.markConnectionSuccess('c1');
      service.markConnectionFailure('c2', 'err');
      expect(service.getProgressState().phase).toBe('completed');
    });
  });

  describe('onProgressUpdate', () => {
    it('should call callback on progress changes', () => {
      const callback = vi.fn();
      service.onProgressUpdate(callback);
      service.initializeWorkflow(mockConnections);
      expect(callback).toHaveBeenCalled();
    });

    it('should return unsubscribe function', () => {
      const callback = vi.fn();
      const unsubscribe = service.onProgressUpdate(callback);
      unsubscribe();
      service.initializeWorkflow(mockConnections);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('onWorkflowComplete', () => {
    it('should call callback with stats on completion', () => {
      const callback = vi.fn();
      service.onWorkflowComplete(callback);
      service.initializeWorkflow([mockConnections[0]]);
      service.markConnectionSuccess('c1');
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          totalProcessed: 1,
          successful: 1,
        })
      );
    });

    it('should return unsubscribe function', () => {
      const callback = vi.fn();
      const unsubscribe = service.onWorkflowComplete(callback);
      unsubscribe();
      service.initializeWorkflow([mockConnections[0]]);
      service.markConnectionSuccess('c1');
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('resetWorkflow', () => {
    it('should clear all state', () => {
      service.initializeWorkflow(mockConnections);
      service.resetWorkflow();
      expect(service.getProgressState().totalConnections).toBe(0);
    });
  });

  describe('stopWorkflow', () => {
    it('should set phase to stopped', () => {
      service.initializeWorkflow(mockConnections);
      service.stopWorkflow();
      expect(service.getProgressState().phase).toBe('stopped');
    });
  });

  describe('status helpers', () => {
    it('isWorkflowActive should return true during generating', () => {
      service.initializeWorkflow(mockConnections);
      service.startProcessingConnection(mockConnections[0], 0);
      expect(service.isWorkflowActive()).toBe(true);
    });

    it('isWorkflowCompleted should return true after all processed', () => {
      service.initializeWorkflow([mockConnections[0]]);
      service.markConnectionSuccess('c1');
      expect(service.isWorkflowCompleted()).toBe(true);
    });

    it('hasWorkflowErrors should return true with failures', () => {
      service.initializeWorkflow([mockConnections[0]]);
      service.markConnectionFailure('c1', 'err');
      expect(service.hasWorkflowErrors()).toBe(true);
    });

    it('getCurrentConnectionName should return undefined if no current connection', () => {
      expect(service.getCurrentConnectionName()).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should handle errors in progress update callbacks', () => {
      const badCallback = () => {
        throw new Error('BOOM');
      };
      service.onProgressUpdate(badCallback);
      service.initializeWorkflow(mockConnections);
    });

    it('should handle errors in completion callbacks', () => {
      const badCallback = () => {
        throw new Error('BOOM');
      };
      service.onWorkflowComplete(badCallback);
      service.initializeWorkflow([mockConnections[0]]);
      service.markConnectionSuccess('c1');
    });

    it('should calculate estimated time remaining', () => {
      vi.useFakeTimers();
      service.initializeWorkflow(mockConnections);

      // Complete first connection after 5 seconds
      vi.advanceTimersByTime(5000);
      service.markConnectionSuccess('c1');

      // Estimate is calculated when starting the NEXT connection
      service.startProcessingConnection(mockConnections[1], 1);

      // 5s for 1 connection, 1 left = 5s remaining
      expect(service.getProgressState().estimatedTimeRemaining).toBe(5);

      vi.useRealTimers();
    });
  });
});
