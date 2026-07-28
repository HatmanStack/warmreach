#!/usr/bin/env bash
# Two-repo sync guard: overlay drift + exclusion-list integrity.
#
# See CLAUDE.md "Two-Repo Sync Architecture". .sync/config.json holds two lists
# and this script checks both:
#
#   overlay_mappings — files that exist in both editions but differ, keyed
#     { "<overlay_path>": "<source_path>" }. Change the source without changing
#     the overlay and the community edition silently regresses behind pro.
#     Checked by ORDER, not by membership: the overlay must not be older than
#     its source. See the block that computes it for why membership was wrong.
#
# What this script CANNOT do: look inside a file. It compares when each side of
# a pair was last edited, so an overlay that was touched later but touched
# WRONGLY — a constant added to the source and not to the overlay — passes here
# by construction. The gate for that class is the community-build CI job, which
# stages the real synced tree and builds, typechecks and tests it.
#
#   exclude_paths — pro-only paths that must never reach the public repo.
#     Deleting an entry is the single highest-risk edit anyone can make to that
#     file, and until 2026-07-27 this script never looked at the list at all.
#
# Usage: scripts/check-overlay-drift.sh [base-ref]
# Default base ref is origin/main. Intended for CI on pull_request events, but
# it is also meant to mean something when run by hand before committing — see
# the note on the change set below.

set -euo pipefail

BASE_REF="${1:-origin/main}"

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  BASE_REF='HEAD~1'
fi

# The change set is the committed range UNIONED with the working tree.
#
# It used to be `git diff --name-only "$BASE_REF"...HEAD` alone — a committed
# range — so an overlay-source edit that was merely staged, or not yet added at
# all, was invisible and the script printed OK. "I ran the drift gate before
# committing" was therefore not evidence of anything, and a real drift shipped
# that way (7ac4bf13, caught only after the commit landed). In CI the tree is
# clean and the union is identical to the committed range.
COMMITTED=$(git diff --name-only "$BASE_REF"...HEAD || true)
UNSTAGED=$(git diff --name-only HEAD || true)
STAGED=$(git diff --name-only --cached || true)
UNTRACKED=$(git ls-files --others --exclude-standard || true)

CHANGED=$(printf '%s\n%s\n%s\n%s\n' "$COMMITTED" "$UNSTAGED" "$STAGED" "$UNTRACKED" | sed '/^$/d' | sort -u)

# The uncommitted half on its own. The drift check compares WHEN each side of a
# pair was last edited, and "not committed yet" is later than every commit in
# the range — a distinction $CHANGED has already flattened away.
UNCOMMITTED=$(printf '%s\n%s\n%s\n' "$UNSTAGED" "$STAGED" "$UNTRACKED" | sed '/^$/d' | sort -u)

COMMITTED_ADDED=$(git diff --name-only --diff-filter=A "$BASE_REF"...HEAD || true)
STAGED_ADDED=$(git diff --name-only --diff-filter=A --cached || true)
ADDED=$(printf '%s\n%s\n%s\n' "$COMMITTED_ADDED" "$STAGED_ADDED" "$UNTRACKED" | sed '/^$/d' | sort -u)

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
export CHANGED
EXEMPT=$(python3 - <<'PY'
import os, re, subprocess

base = os.environ['BASE_REF']
changed = [p for p in os.environ['CHANGED'].splitlines() if p]

# Pattern for a uses: line that pins a SHA, e.g.
#   - uses: actions/setup-node@<40-hex> # v6
USES_PIN = re.compile(r'^\s*-?\s*uses:\s+\S+@[0-9a-f]{40}(\s+#.*)?\s*$')

exempt = []
for path in changed:
    if not path.startswith('.github/workflows/'):
        continue
    # Same union as the change set: a SHA bump sitting in the working tree is
    # exempt for the same reason a committed one is.
    diff = ''
    for args in (
        ['git', 'diff', '--unified=0', f'{base}...HEAD', '--', path],
        ['git', 'diff', '--unified=0', 'HEAD', '--', path],
    ):
        diff += subprocess.run(args, capture_output=True, text=True).stdout
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
export ADDED
export UNCOMMITTED

python3 - <<'PY'
import fnmatch
import json
import os
import subprocess
import sys

base = os.environ['BASE_REF']

with open('.sync/config.json', encoding='utf-8') as f:
    config = json.load(f)
mapping = config['overlay_mappings']
exclude_paths = config['exclude_paths']

changed = set(os.environ.get('CHANGED', '').split('\n')) - {''}
added = set(os.environ.get('ADDED', '').split('\n')) - {''}
exempt = {p for p in os.environ.get('EXEMPT', '').split(',') if p}

failures = []
warnings = []

# ---------------------------------------------------------------------------
# 1. overlay_mappings drift — ORDERING, not set membership
# ---------------------------------------------------------------------------
# This used to ask "did the source path and the overlay path both appear
# somewhere in the change set?". Set membership over a whole range cannot see
# ORDER, so the sequence
#
#     commit A   src + overlay   (pair satisfied)
#     commit B   src only        (overlay now stale — and invisible)
#
# passed: both paths were members of the union, so the pair looked honoured.
# That is how an overlay stayed stale across an entire phase while the gate
# reported OK on every PR in it.
#
# The invariant is that the overlay must not be OLDER than its source. Each
# path is placed on the range's commit timeline and the two positions are
# compared; a tie (same commit, or both sitting in the working tree) passes,
# because that is the shape of a correctly paired edit.
#
# Positions are commit ORDER within the range, never timestamps: a committer
# date is attacker- and rebase-controlled and says nothing about what landed
# after what. `--topo-order --reverse` gives oldest-first, so a larger index is
# later. Two sentinels bracket the range — NEVER_TOUCHED for a path the range
# does not contain at all, and WORKING_TREE for one whose newest edit is not
# committed yet, which is by definition later than everything that is.
NEVER_TOUCHED = -1
WORKING_TREE = 1 << 30

order = {}
rev_list = subprocess.run(
    ['git', 'rev-list', '--topo-order', '--reverse', f'{base}..HEAD'],
    capture_output=True,
    text=True,
)
for index, sha in enumerate(line for line in rev_list.stdout.splitlines() if line):
    order[sha] = index

# Uncommitted (unstaged + staged + untracked) paths, as computed by the shell
# above. `changed` is the union INCLUDING the committed range, so it cannot
# distinguish the two on its own.
uncommitted = set(os.environ.get('UNCOMMITTED', '').split('\n')) - {''}

position_cache = {}


def position(path):
    """Where in the range this path was last edited. Higher is later."""
    if path in position_cache:
        return position_cache[path]
    if path in uncommitted:
        result = WORKING_TREE
    else:
        proc = subprocess.run(
            ['git', 'rev-list', '-1', f'{base}..HEAD', '--', path],
            capture_output=True,
            text=True,
        )
        sha = proc.stdout.strip()
        result = order.get(sha, NEVER_TOUCHED) if sha else NEVER_TOUCHED
    position_cache[path] = result
    return result


drift = []
for overlay_path, source_path in mapping.items():
    if source_path not in changed or source_path in exempt:
        continue
    source_at = position(source_path)
    overlay_at = position(overlay_path)
    if overlay_at < source_at:
        drift.append((source_path, overlay_path, source_at, overlay_at))

if drift:
    lines = ['overlay-drift: source files changed without their overlay counterpart:', '']
    for src, ovl, src_at, ovl_at in drift:

        def where(index):
            if index == NEVER_TOUCHED:
                return 'unchanged in this range'
            if index == WORKING_TREE:
                return 'working tree'
            return f'commit #{index + 1} of the range'

        lines.append(f'  source:  {src}  ({where(src_at)})')
        lines.append(f'  overlay: {ovl}  ({where(ovl_at)})')
        lines.append('')
    lines.append('The overlay is older than its source. Update the overlay — a later')
    lines.append('source-only edit is drift even when an earlier commit in the same')
    lines.append('range did touch the overlay.')
    lines.append("See CLAUDE.md 'Two-Repo Sync Architecture' for guidance.")
    failures.append('\n'.join(lines))


# ---------------------------------------------------------------------------
# 2. A removed exclude_paths entry must state its reason in a commit body
# ---------------------------------------------------------------------------
def base_config():
    proc = subprocess.run(
        ['git', 'show', f'{base}:.sync/config.json'], capture_output=True, text=True
    )
    if proc.returncode != 0:
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None


TRAILER = 'sync-exclusion-removal:'

previous = base_config()
if previous is not None:
    removed = sorted(set(previous.get('exclude_paths', [])) - set(exclude_paths))
    if removed:
        bodies = subprocess.run(
            ['git', 'log', '--format=%B', f'{base}..HEAD'], capture_output=True, text=True
        ).stdout
        declared = set()
        for line in bodies.splitlines():
            stripped = line.strip()
            if stripped.lower().startswith(TRAILER):
                declared.add(stripped[len(TRAILER):].strip())
        undeclared = [
            entry
            for entry in removed
            if not any(entry in d for d in declared)
        ]
        if undeclared:
            lines = [
                'overlay-drift: exclude_paths entries were removed without a stated reason:',
                '',
            ]
            for entry in undeclared:
                lines.append(f'  removed: {entry}')
            lines += [
                '',
                'Deleting an exclusion publishes a pro-only path to the public repo on the',
                'next push to main, and that is unrecoverable once GitHub has forked or',
                'cached it. If the removal is intended, say so in a commit body:',
                '',
                f'  {TRAILER} <the entry> — <why it is no longer pro-only>',
            ]
            failures.append('\n'.join(lines))


# ---------------------------------------------------------------------------
# 3. Heuristic: a new file that looks pro-only but carries no exclusion
# ---------------------------------------------------------------------------
# Warn, never fail. The false-positive rate on a heuristic like this is exactly
# what turns a gate into noise that everyone learns to ignore. The fail-closed
# backstop for a genuinely forgotten entry is scripts/check-sync-leak.sh.
PRO_COMPONENTS = ('admin/', '.sync/', 'docs/plans/')


def covered(path):
    if path.startswith(PRO_COMPONENTS):
        return True
    for entry in exclude_paths:
        if path == entry or path.startswith(entry + '/'):
            return True
        if fnmatch.fnmatch(path, entry):
            return True
        # A glob entry naming a directory, e.g. `frontend/src/features/x*`.
        parts = path.split('/')
        for i in range(1, len(parts)):
            if fnmatch.fnmatch('/'.join(parts[:i]), entry):
                return True
    return False


suspicious = []
for path in sorted(added):
    if covered(path):
        continue
    directory = os.path.dirname(path)
    if not directory or not os.path.isdir(directory):
        continue
    siblings = [
        os.path.join(directory, name)
        for name in os.listdir(directory)
        if os.path.isfile(os.path.join(directory, name))
    ]
    siblings = [s for s in siblings if s != path]
    if siblings and all(covered(s) for s in siblings):
        suspicious.append((path, directory))

if suspicious:
    lines = ['overlay-drift: WARNING — new files whose siblings are all pro-only:', '']
    for path, directory in suspicious:
        lines.append(f'  {path}  (every other file in {directory}/ is in exclude_paths)')
    lines += [
        '',
        'If this file is pro-only too, add it to exclude_paths. This is a warning,',
        'not a failure — check-sync-leak.sh is the fail-closed backstop.',
    ]
    warnings.append('\n'.join(lines))


# ---------------------------------------------------------------------------
for block in warnings:
    print(block)
    print()

if failures:
    for block in failures:
        print(block)
        print()
    sys.exit(1)

print(
    f'overlay-drift: OK ({len(mapping)} overlay mappings and '
    f'{len(exclude_paths)} exclusions checked against {base} + the working tree)'
)
PY
