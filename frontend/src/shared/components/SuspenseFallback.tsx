import { Loader2 } from 'lucide-react';

/**
 * Minimal route-loading fallback for React Suspense.
 *
 * Replaces `<Suspense fallback={null}>`, which rendered nothing (a blank screen)
 * while a lazily-imported route chunk loaded. A centered spinner gives the user
 * feedback that navigation is in progress. Kept dependency-free (reuses the
 * already-present `lucide-react` icon) so it syncs cleanly to the community edition.
 */
export function SuspenseFallback() {
  return (
    <div
      data-testid="suspense-fallback"
      role="status"
      aria-label="Loading"
      className="flex min-h-screen items-center justify-center"
    >
      <Loader2 className="h-8 w-8 animate-spin text-blue-400" />
    </div>
  );
}
