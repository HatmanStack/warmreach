#!/usr/bin/env bash
# Skip-test lint.
#
# Fails CI when a test is skipped without a linked tracking issue. A skip is
# acceptable *only* if the same line (or the line directly above it) contains
# either a full issue URL or a `TODO(#123)`-style reference.
#
# Patterns detected:
#   - JavaScript/TypeScript: it.skip(, test.skip(, describe.skip(, xit(, xdescribe(, xtest(
#   - Python:                @pytest.mark.skip, @pytest.mark.skipif
#
# Usage: scripts/check-skipped-tests.sh

set -uo pipefail

ROOTS=(
  frontend/src
  client/src
  admin/src
  tests/backend/unit
  tests/backend/integration
)

# Build a single regex for JS/TS skip patterns.
JS_PATTERN='(\.skip\(|xit\(|xdescribe\(|xtest\()'
PY_PATTERN='@pytest\.mark\.(skip|skipif)'
ALLOW_PATTERN='(TODO\(#[0-9]+\)|https?://[^ ]*/issues/[0-9]+|https?://[^ ]*/pull/[0-9]+)'

hits=()

for root in "${ROOTS[@]}"; do
  [ -d "$root" ] || continue

  while IFS=: read -r file line content; do
    # Fetch the previous line to check for a trailing/preceding issue ref.
    prev=''
    if [ "$line" -gt 1 ]; then
      prev=$(sed -n "$((line-1))p" "$file" || true)
    fi
    combined="$content $prev"
    if ! echo "$combined" | grep -Eq "$ALLOW_PATTERN"; then
      hits+=("$file:$line: $content")
    fi
  done < <(
    grep -rEn "$JS_PATTERN" "$root" \
      --include='*.test.ts' \
      --include='*.test.tsx' \
      --include='*.test.js' \
      --include='*.test.mjs' 2>/dev/null || true
  )

  while IFS=: read -r file line content; do
    prev=''
    if [ "$line" -gt 1 ]; then
      prev=$(sed -n "$((line-1))p" "$file" || true)
    fi
    combined="$content $prev"
    if ! echo "$combined" | grep -Eq "$ALLOW_PATTERN"; then
      hits+=("$file:$line: $content")
    fi
  done < <(
    grep -rEn "$PY_PATTERN" "$root" \
      --include='*.py' 2>/dev/null || true
  )
done

if [ "${#hits[@]}" -gt 0 ]; then
  echo "check-skipped-tests: the following skipped tests are missing a tracking reference:"
  echo '  (either a GitHub issue URL or a TODO(#NNN) on the same or previous line)'
  echo
  printf '  %s\n' "${hits[@]}"
  exit 1
fi

echo "check-skipped-tests: OK (no untracked skips)"
