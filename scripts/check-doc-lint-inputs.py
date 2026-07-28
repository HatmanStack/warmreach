#!/usr/bin/env python3
"""Assert every doc-linter input survives the sync to the community edition.

markdownlint and lychee are pointed at their inputs from two files that BOTH
sync verbatim — `package.json` and `.github/workflows/docs-lint.yml`. A path that
is correct in this repository can therefore be missing in the community one, and
the two linters do not treat that the same way:

  * a GLOB that matches nothing is fine in both;
  * a LITERAL path that does not exist is fatal to lychee. It stops treating the
    argument as a file and resolves it as a URL, which dies on a DNS error and
    exits 1.

`admin/README.md` shipped exactly that way. `admin/` is in `exclude_paths`, so
the community repository's docs gate — BLOCKING per CLAUDE.md — would have been
red from the first sync onward. Pro passed, so nothing local saw it.

The rule this enforces: any literal input must be a path the sync cannot take
away. Use a glob when it can.

This lives in `scripts/` and runs in the unconditional "Repo Invariants" CI job
rather than in the backend test suite. Its subject is root configuration, not
backend code, and the backend job is gated on a `backend/**` + `tests/backend/**`
path filter — so as a pytest it did not run on the very PR shape that introduced
the bug (`docs-lint.yml`, `lychee.toml`, `package.json` → `changes.backend`
false, job skipped, skipped treated as success).

Runs in both editions. The existence half applies everywhere; the
`exclude_paths` half needs `.sync/config.json`, which is pro-only, and is
skipped with a note when it is absent rather than silently dropped.

Usage: python3 scripts/check-doc-lint-inputs.py [--root <dir>]
Exit 0 when every input is safe, 1 on a violation, 2 when the file shapes this
parses have moved.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
import sys
from pathlib import Path

GLOB_CHARS = '*?['

# The four places a doc linter is pointed at its inputs. If one is renamed or
# removed this script must fail loudly rather than quietly checking three.
EXPECTED_INVOCATIONS = 4

PACKAGE_SCRIPTS = ('lint:docs', 'lint:docs:links')
WORKFLOW_PREFIXES = (
    ('docs-lint.yml markdownlint', 'run: npx markdownlint-cli2'),
    ('docs-lint.yml lychee', 'args: --config lychee.toml'),
)


def fail(message: str) -> int:
    print(f'check-doc-lint-inputs: {message}', file=sys.stderr)
    return 2


def collect_invocations(root: Path) -> dict[str, str] | int:
    package_json = root / 'package.json'
    workflow = root / '.github' / 'workflows' / 'docs-lint.yml'
    if not package_json.is_file():
        return fail(f'{package_json} not found')
    if not workflow.is_file():
        return fail(f'{workflow} not found')

    scripts = json.loads(package_json.read_text(encoding='utf-8')).get('scripts', {})
    invocations: dict[str, str] = {}
    for name in PACKAGE_SCRIPTS:
        if name not in scripts:
            return fail(f'package.json has no {name!r} script')
        invocations[f'package.json {name}'] = scripts[name]

    text = workflow.read_text(encoding='utf-8')
    for label, prefix in WORKFLOW_PREFIXES:
        # The leading `- ` is optional: whether a step's key opens a YAML
        # sequence item depends on where `name:` sits, and a reformat there must
        # not turn this check into an error.
        found = [
            line.strip().removeprefix('- ')
            for line in text.splitlines()
            if line.strip().removeprefix('- ').startswith(prefix)
        ]
        if len(found) != 1:
            return fail(f'{workflow}: expected exactly one line starting {prefix!r}, found {len(found)}')
        invocations[label] = found[0]

    if len(invocations) != EXPECTED_INVOCATIONS:
        return fail(f'expected {EXPECTED_INVOCATIONS} doc-linter invocations, found {len(invocations)}')
    return invocations


def path_arguments(command: str) -> list[str]:
    """Quoted arguments that are inputs, not flags or config files."""
    args = []
    for arg in re.findall(r'"([^"]+)"', command):
        if arg.startswith('-') or arg.endswith('.toml'):
            continue
        args.append(arg)
    return args


def sync_removes(path: str, exclude_paths: list[str]) -> str | None:
    """The exclude_paths entry that deletes `path`, if any.

    Glob entries are matched as globs. sync.sh passes exclude_paths straight to
    `rsync --exclude`, so `docs/*.local.md` and `.env.*` really do delete
    matching files — but a literal string comparison never matched them, which
    would have let a doc-linter input named by a glob look safe here.
    """
    for entry in exclude_paths:
        if path == entry or path.startswith(entry + '/'):
            return entry
        parts = path.split('/')
        for i in range(1, len(parts)):
            if '/'.join(parts[:i]) == entry:
                return entry
        if any(ch in entry for ch in '*?[') and (
            fnmatch.fnmatch(path, entry) or fnmatch.fnmatch(path, entry + '/*')
        ):
            return entry
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=None, help='repository root (defaults to this script\'s repo)')
    args = parser.parse_args()

    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parent.parent

    invocations = collect_invocations(root)
    if isinstance(invocations, int):
        return invocations

    config = root / '.sync' / 'config.json'
    if config.is_file():
        exclude_paths = json.loads(config.read_text(encoding='utf-8'))['exclude_paths']
        note = None
    else:
        exclude_paths = []
        note = (
            'no .sync/config.json here, so only the existence half runs — this is '
            'the community edition, where the sync has already happened'
        )

    checked = 0
    problems: list[str] = []
    for label, command in invocations.items():
        inputs = path_arguments(command)
        if not inputs:
            return fail(f'{label}: parsed zero inputs out of {command!r}')
        for arg in inputs:
            if any(ch in arg for ch in GLOB_CHARS):
                continue  # both linters tolerate a glob that matches nothing
            checked += 1
            if not (root / arg).exists():
                problems.append(f'{label}: {arg!r} does not exist')
                continue
            entry = sync_removes(arg, exclude_paths)
            if entry:
                problems.append(
                    f'{label}: {arg!r} is removed by the {entry!r} sync exclusion; '
                    f'use a glob so it degrades to an empty match'
                )

    if note:
        print(f'check-doc-lint-inputs: {note}')

    if problems:
        print('check-doc-lint-inputs: doc-linter inputs that will not survive the sync:')
        print()
        for problem in problems:
            print(f'  {problem}')
        print()
        print('lychee resolves a missing local path as a URL and exits 1, so this would')
        print("turn the community edition's BLOCKING docs gate red on its first run.")
        return 1

    print(
        f'check-doc-lint-inputs: OK ({len(invocations)} invocations, '
        f'{checked} literal input(s) checked)'
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
