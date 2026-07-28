import type { Connection, UserProfile, Message, ProgressState, TierInfo } from '@/shared/types';

/**
 * Factory for creating mock Connection objects.
 */
export function buildConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'test-connection-id' as string,
    first_name: 'John',
    last_name: 'Doe',
    position: 'Software Engineer',
    company: 'TechCorp',
    status: 'ally',
    ...overrides,
  };
}

/**
 * Factory for creating mock UserProfile objects.
 */
export function buildUserProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    user_id: 'test-user-id',
    first_name: 'Jane',
    last_name: 'Smith',
    email: 'jane.smith@example.com',
    headline: 'Product Manager at DataCo',
    ...overrides,
  };
}

/**
 * Factory for creating mock Message objects.
 */
export function buildMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'test-message-id' as string,
    content: 'Hello, this is a test message.',
    timestamp: new Date().toISOString(),
    sender: 'user',
    ...overrides,
  };
}

/**
 * Factory for creating mock SearchResult objects from RAGStack.
 */
export interface SearchResult {
  profileId: string;
  score: number;
  snippet: string;
}

export function buildSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    profileId: 'test-profile-id',
    score: 0.95,
    snippet: 'Experienced software engineer with a focus on React and TypeScript.',
    ...overrides,
  };
}

/**
 * Factory for creating mock Command objects.
 */
export interface Command {
  commandId: string;
}

export function buildCommand(overrides: Partial<Command> = {}): Command {
  return {
    commandId: 'test-command-id',
    ...overrides,
  };
}

/**
 * Factory for creating mock Edge objects.
 */
export interface Edge {
  id: string;
  userId: string;
  profileId: string;
  status: string;
  lastAction?: string;
}

export function buildEdge(overrides: Partial<Edge> = {}): Edge {
  return {
    id: 'test-edge-id',
    userId: 'test-user-id',
    profileId: 'test-profile-id',
    status: 'connected',
    ...overrides,
  };
}

/**
 * Factory for creating mock WorkflowState (ProgressState) objects.
 */
export function buildWorkflowState(overrides: Partial<ProgressState> = {}): ProgressState {
  return {
    current: 1,
    total: 10,
    phase: 'generating',
    ...overrides,
  };
}

/**
 * Factory for creating mock TierInfo objects.
 */
export function buildTierInfo(overrides: Partial<TierInfo> = {}): TierInfo {
  return {
    tier: 'pro',
    features: {
      advanced_search: true,
      priority_support: true,
      unlimited_messages: true,
    },
    // TierQuotas is a flat name -> limit map, matching what tier_service.py
    // actually returns (daily/hourly/monthly_linkedin_interactions, li_actions).
    // The previous fixture used {used, limit} objects under quota names the
    // backend has never emitted; nothing could have matched it.
    quotas: {
      daily_linkedin_interactions: 50,
      hourly_linkedin_interactions: 15,
      monthly_linkedin_interactions: 500,
    },
    rateLimits: {
      linkedin_interactions_per_minute: 5,
    },
    ...overrides,
  };
}
