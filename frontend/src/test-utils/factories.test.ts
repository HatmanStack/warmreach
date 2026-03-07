import { describe, it, expect } from 'vitest';
import {
  buildConnection,
  buildUserProfile,
  buildMessage,
  buildSearchResult,
  buildCommand,
  buildEdge,
  buildWorkflowState,
  buildTierInfo,
} from './factories';

describe('Test Factories', () => {
  it('should build connection with overrides', () => {
    const conn = buildConnection({ id: 'custom', first_name: 'Bob' });
    expect(conn.id).toBe('custom');
    expect(conn.first_name).toBe('Bob');
    expect(conn.last_name).toBe('Doe'); // default
  });

  it('should build user profile with overrides', () => {
    const profile = buildUserProfile({ user_id: 'u1' });
    expect(profile.user_id).toBe('u1');
    expect(profile.first_name).toBe('Jane');
  });

  it('should build message with overrides', () => {
    const msg = buildMessage({ id: 'm1' });
    expect(msg.id).toBe('m1');
    expect(msg.sender).toBe('user');
  });

  it('should build search result with overrides', () => {
    const res = buildSearchResult({ profileId: 'p1' });
    expect(res.profileId).toBe('p1');
  });

  it('should build command with overrides', () => {
    const cmd = buildCommand({ commandId: 'c1' });
    expect(cmd.commandId).toBe('c1');
  });

  it('should build edge with overrides', () => {
    const edge = buildEdge({ id: 'e1' });
    expect(edge.id).toBe('e1');
  });

  it('should build workflow state with overrides', () => {
    const state = buildWorkflowState({ current: 5 });
    expect(state.current).toBe(5);
    expect(state.total).toBe(10);
  });

  it('should build tier info with overrides', () => {
    const tier = buildTierInfo({ tier: 'free' });
    expect(tier.tier).toBe('free');
    expect(tier.features.advanced_search).toBe(true);
  });
});
