# ADR-013: Mutual-connection collection is consent-gated, opt-in and default off

## Status

Accepted

## Context

Building the adjacency mesh of [ADR-010](./ADR-010-private-per-user-adjacency-store.md)
requires visiting a contact's shared-connections surface, which is an extra
LinkedIn navigation performed on the user's own authenticated session. That is
exactly the kind of behaviour that must be a deliberate choice rather than a
silent default.

The cited site is `frontend/src/features/profile/hooks/useProfileInit.ts:90`:

```ts
// Include collectMutuals only when the user has opted in (ADR-013); the
// client collects nothing when the flag is absent/false.
const collectMutuals = userProfile?.mutual_scrape_opt_in === true;
```

and `client/src/domains/profile/controllers/profileInitController.ts:724`:

```ts
// Consent flag (ADR-013): only an explicit true from the payload enables
// mutual-connections collection; carried through into ingestion state.
collectMutuals: payload.collectMutuals === true,
```

## Decision

A `UserProfile.mutual_scrape_opt_in` boolean, absent by default, gates all
mutual-connection collection. The frontend includes a derived `collectMutuals`
boolean in the `linkedin:profile-init` command payload **only** when the toggle
is on. The client honours `collectMutuals` inside `processConnection` and
collects nothing when the flag is absent or false — the check is an explicit
`=== true`, not a truthiness test. Persistence reuses the existing settings
allowlist in `backend/lambdas/dynamodb-api/services/dynamodb_api_service.py`,
alongside `digest_opted_out` and `comment_concierge_mode`.

## Consequences

- Consent travels on the command payload the client already receives, so the
  desktop client needs no new settings-fetch capability and cannot collect on a
  stale cached preference.
- Turning the toggle off stops collection on the next run; it does not delete
  adjacency already stored. Erasure is handled by the data-rights path.
- Both the frontend derivation and the client-side read are strict boolean
  comparisons, so a truthy non-boolean value in a hand-crafted payload does not
  enable collection.
