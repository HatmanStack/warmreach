# ADR-007: Client-side filtering for non-ingested (possible) connections

## Status

Accepted

## Context

The NewConnections tab displays "possible" contacts — profiles discovered through search or referral that have not been accepted into the user's network yet. These profiles are not ingested into RAGStack because ingestion is a paid, rate-limited operation reserved for connections the user has opted to track.

The cited site is `frontend/src/features/connections/components/NewConnectionsTab.tsx:44`:

```tsx
// Local search query state for client-side filtering
// Note: NewConnections shows "possible" contacts which are NOT ingested into RAGStack
// per ADR-007, so we use client-side filtering instead of semantic search
const [searchQuery, setSearchQuery] = useState('');
```

## Decision

The NewConnections tab uses client-side substring filtering over the already-fetched list. It does not call the semantic search endpoint.

## Consequences

- The tab works offline once the list is loaded, and every keystroke is free.
- Search quality is substring-only. Typos and semantic near-matches do not surface, which is acceptable for a typically short "possible" list (bounded by the caller's page size).
- If a user's "possible" list grows past the point where client filtering feels slow, the fix is pagination, not semantic search — ingesting "possible" profiles would inflate RAGStack cost and is out of scope here.
- The accepted-connections tab continues to use semantic search through RAGStack, unchanged.
