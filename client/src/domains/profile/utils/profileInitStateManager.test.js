import { describe, it, expect } from 'vitest';
import { ProfileInitStateManager } from './profileInitStateManager.js';

describe('ProfileInitStateManager', () => {
  describe('buildInitialState', () => {
    it('should build state with default values', () => {
      const state = ProfileInitStateManager.buildInitialState({
        searchName: 'user',
        searchPassword: 'pass',
        jwtToken: 'token',
      });

      expect(state.searchName).toBe('user');
      expect(state.recursionCount).toBe(0);
      expect(state.batchSize).toBe(100);
      expect(state.timestamp).toBeDefined();
    });
  });

  describe('validateState', () => {
    it('should throw if credentials are missing', () => {
      const state = { jwtToken: 'token' };
      expect(() => ProfileInitStateManager.validateState(state)).toThrow(
        'Missing required credentials'
      );
    });

    it('should throw if jwtToken is missing', () => {
      const state = { searchName: 'u', searchPassword: 'p' };
      expect(() => ProfileInitStateManager.validateState(state)).toThrow(
        'Missing required state field: jwtToken'
      );
    });

    it('should not throw if state is valid', () => {
      const state = { searchName: 'u', searchPassword: 'p', jwtToken: 't' };
      expect(() => ProfileInitStateManager.validateState(state)).not.toThrow();
    });
  });

  describe('buildHealingState', () => {
    it('should increment recursionCount and update phase/reason', () => {
      const base = { recursionCount: 0, other: 'data' };
      const healing = { healPhase: 'test', healReason: 'fail' };
      const state = ProfileInitStateManager.buildHealingState(base, healing);

      expect(state.recursionCount).toBe(1);
      expect(state.healPhase).toBe('test');
      expect(state.healReason).toBe('fail');
      expect(state.other).toBe('data');
    });
  });

  describe('getProgressSummary', () => {
    it('should calculate correct percentage', () => {
      const state = {
        totalConnections: { all: 100 },
        completedBatches: ['b1'], // 1 batch of 100
        batchSize: 100,
        currentIndex: 50,
      };
      const summary = ProfileInitStateManager.getProgressSummary(state);
      // estimatedProcessed = 1 * 100 + 50 = 150
      // percentage = 150 / 100 = 150% (capped at 100 in implementation? No, min(100, ...))
      expect(summary.progressPercentage).toBe(100);
      expect(summary.estimatedProcessed).toBe(150);
    });
  });
});
