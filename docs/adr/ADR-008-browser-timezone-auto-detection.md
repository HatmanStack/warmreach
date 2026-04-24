# ADR-008: Browser-side timezone auto-detection and persistence

## Status

Accepted

## Context

Send-time recommendations and digest scheduling need the user's timezone. Asking the user to select a timezone at onboarding adds friction, and `Intl.DateTimeFormat().resolvedOptions().timeZone` is reliable across every browser the frontend supports.

The cited site is `frontend/src/features/profile/contexts/UserProfileContext.tsx:55`:

```tsx
// Auto-detect timezone and save if not yet set or changed (ADR-008)
try {
  const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const storedTimezone = response.data.timezone;
  if (detectedTimezone && detectedTimezone !== storedTimezone) {
    // Fire-and-forget: do not block profile fetch flow
    profileApiService...
  }
}
```

## Decision

On profile load, the frontend reads the browser's resolved timezone and compares it to the stored value. If they differ, it fires a fire-and-forget update to the profile API. The profile fetch flow never blocks on the update.

## Consequences

- Users who travel have their timezone silently updated to match their current location on next profile load.
- A user who deliberately pinned a non-local timezone via the profile UI would see it overwritten. Acceptable today because no such UI exists; a future manual-timezone feature must suppress auto-detection when a user flag is set.
- The update is fire-and-forget, so a failed save is logged and retried on the next load. It never surfaces as a user-visible error.
- Because the update runs inside the profile-fetch flow, it does not add a round trip for users whose timezone is already correct.
