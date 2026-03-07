import { describe, it, expect } from 'vitest';
import { SearchStateManager } from './searchStateManager.js';

describe('SearchStateManager', () => {
  describe('buildInitialState', () => {
    it('should build state with default values', () => {
      const input = {
        companyName: 'Tech',
        jwtToken: 'token',
      };
      const state = SearchStateManager.buildInitialState(input);

      expect(state.companyName).toBe('Tech');
      expect(state.jwtToken).toBe('token');
      expect(state.resumeIndex).toBe(0);
      expect(state.recursionCount).toBe(0);
      expect(state.healPhase).toBeNull();
    });

    it('should preserve provided values', () => {
      const input = {
        companyName: 'Tech',
        jwtToken: 'token',
        resumeIndex: 5,
        healPhase: 'test',
      };
      const state = SearchStateManager.buildInitialState(input);

      expect(state.resumeIndex).toBe(5);
      expect(state.healPhase).toBe('test');
    });

    it('should handle extra options', () => {
      const input = {
        companyName: 'Tech',
        extra: 'option',
      };
      const state = SearchStateManager.buildInitialState(input);
      expect(state.extra).toBe('option');
    });

    it('should handle negative resumeIndex', () => {
      const input = {
        companyName: 'Tech',
        resumeIndex: -1,
      };
      const state = SearchStateManager.buildInitialState(input);
      expect(state.resumeIndex).toBe(-1);
    });
  });
});
