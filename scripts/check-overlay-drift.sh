#!/usr/bin/env bash
# Overlay-drift check.
#
# Two-repo sync (see CLAUDE.md): when a source file listed in
# .sync/config.json overlay_mappings is modified, the corresponding overlay
# in .sync/overlays/ must change in the same PR. Otherwise the community
# edition built by the sync workflow silently regresses behind pro.
#
# The mapping in .sync/config.json is structured as { "<overlay_path>": "<source_path>" }.
#
# Usage: scripts/check-overlay-drift.sh [base-ref]
# Default base ref is origin/main. Intended for CI on pull_request events.

set -euo pipefail

BASE_REF="${1:-origin/main}"

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  BASE_REF='HEAD~1'
fi

CHANGED=$(git diff --name-only "$BASE_REF"...HEAD || true)

if [ -z "$CHANGED" ]; then
  echo "overlay-drift: no changes vs $BASE_REF"
  exit 0
fi

export CHANGED

python3 - <<'PY'
import json
import os
import sys

with open('.sync/config.json', encoding='utf-8') as f:
    mapping = json.load(f)['overlay_mappings']

changed = set(os.environ.get('CHANGED', '').split())

drift = []
for overlay_path, source_path in mapping.items():
    if source_path in changed and overlay_path not in changed:
        drift.append((source_path, overlay_path))

if drift:
    print('overlay-drift: source files changed without their overlay counterpart:')
    print()
    for src, ovl in drift:
        print(f'  source:  {src}')
        print(f'  overlay: {ovl}')
        print()
    print('Update the overlay in the same commit range, or revert the source change.')
    print("See CLAUDE.md 'Two-Repo Sync Architecture' for guidance.")
    sys.exit(1)

print('overlay-drift: OK (all modified source files have matching overlay updates)')
PY
