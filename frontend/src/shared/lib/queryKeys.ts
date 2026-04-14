export const queryKeys = {
  connections: {
    all: ['connections'] as const,
    byStatus: (status: string) => ['connections', 'status', status] as const,
    byUser: (userId: string) => ['connections', 'user', userId] as const,
  },
  search: {
    results: ['search', 'results'] as const,
    visited: ['search', 'visited'] as const,
  },
  messages: {
    history: (connectionId: string) => ['messages', 'history', connectionId] as const,
  },
  activity: {
    timeline: (userId: string) => ['activity', 'timeline', userId] as const,
  },
  notes: {
    byConnection: (connectionId: string) => ['notes', connectionId] as const,
  },
  influenceScores: {
    all: ['influenceScores'] as const,
  },
  gapAnalysis: {
    byOpportunity: (opportunityId: string) => ['gapAnalysis', opportunityId] as const,
  },
  opportunities: {
    all: ['opportunities'] as const,
    byStatus: (status: string) => ['opportunities', 'status', status] as const,
    connections: (opportunityId: string) =>
      ['opportunities', 'connections', opportunityId] as const,
    evidence: (opportunityId: string) => ['opportunities', 'evidence', opportunityId] as const,
    assessment: (opportunityId: string) => ['opportunities', 'assessment', opportunityId] as const,
    requirements: (opportunityId: string) =>
      ['opportunities', 'requirements', opportunityId] as const,
    feedback: (opportunityId: string) => ['opportunities', 'feedback', opportunityId] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    unreadCount: ['notifications', 'unreadCount'] as const,
  },
} as const;
