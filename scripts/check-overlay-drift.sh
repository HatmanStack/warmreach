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

# Workflow files in source pin actions to commit SHAs (Dependabot bumps these).
# Their overlays use tag refs (@v6) and auto-track. A source-only diff that's
# purely an action SHA pin bump does not require an overlay change. We compute
# the set of such "exempt" workflow files and pass them as a comma-separated
# list so the python check can ignore them when scanning for drift.
export BASE_REF
EXEMPT=$(python3 - <<'PY'
import os, re, subprocess

base = os.environ['BASE_REF']
changed = subprocess.check_output(
    ['git', 'diff', '--name-only', f'{base}...HEAD'], text=True
).split()

# Pattern for a uses: line that pins a SHA, e.g.
#   - uses: actions/setup-node@<40-hex> # v6
USES_PIN = re.compile(r'^\s*-?\s*uses:\s+\S+@[0-9a-f]{40}(\s+#.*)?\s*$')

exempt = []
for path in changed:
    if not path.startswith('.github/workflows/'):
        continue
    diff = subprocess.check_output(
        ['git', 'diff', '--unified=0', f'{base}...HEAD', '--', path], text=True
    )
    only_uses = True
    saw_change = False
    for line in diff.splitlines():
        if line.startswith(('diff ', 'index ', '---', '+++', '@@')) or not line:
            continue
        if line.startswith(('+', '-')) and not line.startswith(('+++', '---')):
            saw_change = True
            content = line[1:]
            if not USES_PIN.match(content):
                only_uses = False
                break
    if saw_change and only_uses:
        exempt.append(path)

print(','.join(exempt))
PY
)
export EXEMPT
export CHANGED

python3 - <<'PY'
import json
import os
import sys

with open('.sync/config.json', encoding='utf-8') as f:
    mapping = json.load(f)['overlay_mappings']

changed = set(os.environ.get('CHANGED', '').split())
exempt = {p for p in os.environ.get('EXEMPT', '').split(',') if p}

drift = []
for overlay_path, source_path in mapping.items():
    if source_path in changed and overlay_path not in changed and source_path not in exempt:
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
