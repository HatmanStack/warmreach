#!/usr/bin/env bash
# mypy over the whole backend: the shared_services package plus every Lambda
# directory, one invocation each.
#
# Why a loop rather than one pass: the per-Lambda handlers are all named
# `lambda_function`, and several Lambdas carry same-named sibling modules too, so
# a single invocation cannot resolve them. One pass per directory is the only way
# to check them at all.
#
# Runs from CI and from `npm run typecheck:backend` so the two are identical.
#
# Introduced green, after fixing the errors it surfaced: measured on 2026-07-27
# with mypy 2.1.0 (what requirements-test.lock pins, so what CI runs), the handler
# half was 26 errors across 9 of the 23 checked directories; the other 14 were
# already clean. Per-directory detail is deliberately not listed here — this file
# syncs verbatim, and naming the pro-only directories would publish them.
# To re-derive on a tree that has moved, run this script and read each invocation's
# own `Found N errors` line. Do not count with `grep -c ': error:'`: mypy's usage
# errors match that pattern too, so a mistyped flag returns a plausible number
# instead of failing.

set -uo pipefail

# `|| exit 1` is load-bearing: `set -e` is deliberately OFF (see the bottom of
# this file), so a failed cd would fall through and every mypy invocation below
# would resolve `lambdas/*/` against the CALLER's directory. The glob would match
# nothing, the loop would run zero times, and the script would exit 0 — reporting
# a clean typecheck over nothing at all.
cd "$(dirname "$0")/../backend" || exit 1

failed=0
checked=0

run() {
  local label="$1"
  shift
  echo "--- mypy: ${label}"
  if ! "$@"; then
    failed=1
  fi
  checked=$((checked + 1))
}

run 'shared_services (package)' python -m mypy -p shared_services

for dir in lambdas/*/; do
  name="$(basename "$dir")"

  # `shared` is the Lambda layer, already covered by the package run above.
  [ "$name" = 'shared' ] && continue

  # Selecting on `lambda_function.py` would silently skip agent-action-task,
  # whose four Step Functions task workers (including gate_dispatch.py, named in
  # the plan's own invariant list) have no file by that name. Select on "holds
  # any Python at all" instead, so a new handler cannot be added under a name
  # this loop does not know about and go unchecked.
  if [ -z "$(find "$dir" -name '*.py' -print -quit)" ]; then
    continue
  fi

  run "$name" env MYPYPATH=lambdas/shared/python python -m mypy "$dir"
done

echo "--- ${checked} mypy invocation(s)"

# Deliberately not `set -e` / not short-circuiting on the first failure: someone
# fixing types wants the whole list, not the first directory that breaks.
exit "$failed"
