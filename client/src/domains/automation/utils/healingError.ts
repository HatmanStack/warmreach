/**
 * Thrown by a controller's healing hook to request an in-process resume of the
 * current automation from a resume state.
 *
 * The run-with-healing loop (`SearchController.runSearchWithHealing` /
 * `ProfileInitController.runProfileInitWithHealing`) catches it, unwinds the
 * current attempt (whose `finally` closes the browser), checks a recursion cap,
 * and re-invokes the phase from `healState` with a fresh browser.
 *
 * This replaces the old detached-worker spawn (`HealingManager`), whose worker
 * scripts were deleted stubs — so every "self-healing restart" was a silent
 * no-op that ended the run with partial results.
 */
export class HealingRequiredError extends Error {
  healState: Record<string, unknown>;

  constructor(healState: Record<string, unknown>) {
    const phase = (healState?.healPhase as string) ?? 'unknown';
    const reason = (healState?.healReason as string) ?? 'unknown';
    super(`Healing requested (phase=${phase}, reason=${reason})`);
    this.name = 'HealingRequiredError';
    this.healState = healState;
  }
}
