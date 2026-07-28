#!/usr/bin/env python3
"""Command-vocabulary drift check across the six sites that mirror it.

`linkedin:add-connection` and its siblings are independently maintained string
literals in six places across two languages. `create_command` accepts any string
and persists it, so a typo used to produce a command that was written, rate
limited, dispatched over WebSocket, and then silently unroutable at the client.
The dispatch core now rejects an unknown type with a 400; this stops the six
sites diverging in the first place.

The sets are deliberately different subsets, so this asserts the RELATIONSHIPS,
not equality:

    ROUTES keys == schema validator keys                          (exact)
    ROUTES keys is a subset of KNOWN_COMMAND_TYPES
    KNOWN_COMMAND_TYPES == ROUTES keys                            (pro repo only)
    LI_ACTION_COMMAND_TYPES       is a subset of ROUTES keys
    COMMAND_TYPE_BY_ACTION values is a subset of ROUTES keys
    commandService's two lists    are subsets of ROUTES keys

The KNOWN_COMMAND_TYPES equality is asserted in the pro repository only, and the
asymmetry is deliberate rather than a loophole. command_dispatch_core.py syncs
verbatim, but commandRouter.ts is overlaid: the community edition routes the 5
core LinkedIn commands and does not construct the GitHub controller or the
comment/feed services, all of which are exclude_paths. So its backend allowlist
is legitimately a superset of what its client can route. In pro, where every
handler ships, a KNOWN_COMMAND_TYPES entry with no route IS the silent-drop bug,
so equality is required. Presence of .sync/config.json is what distinguishes the
two — it is the one thing that never reaches the community repo.

Regex-based and standard-library-only, in the same spirit as
scripts/check-doc-tables.py: these files cannot be safely imported (TypeScript
on one side, a Lambda layer on sys.path on the other).

Sites that do not exist are skipped with a note rather than failing —
backend/lambdas/agent-action-task/ is pro-only, so this script has to mean
something in both editions.

Usage: python3 scripts/check-command-vocabulary.py
Exit 0 when consistent, 1 on drift, 2 on a malformed or missing required site.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

ROUTER = 'client/src/transport/commandRouter.ts'
SCHEMAS = 'client/src/transport/commandRouter.schemas.ts'
DISPATCH_CORE = 'backend/lambdas/shared/python/shared_services/command_dispatch_core.py'
GATE = 'backend/lambdas/linkedin-action-gate/lambda_function.py'
AGENT_GATE = 'backend/lambdas/agent-action-task/gate_dispatch.py'
COMMAND_SERVICE = 'frontend/src/shared/services/commandService.ts'

# A command type: <namespace>:<kebab-name>. Deliberately narrow, so an unrelated
# quoted string inside one of these blocks cannot be mistaken for a command.
TYPE_RE = r"[a-z][a-z0-9]*:[a-z][a-z0-9-]*"


def read(rel: str) -> str | None:
    path = REPO_ROOT / rel
    if not path.is_file():
        return None
    return path.read_text(encoding='utf-8')


def fail(message: str) -> None:
    print(f'check-command-vocabulary: {message}', file=sys.stderr)
    sys.exit(2)


def block_after(text: str, anchor: str, rel: str, closer: str) -> str:
    """The literal block that starts at `anchor` and ends at its closing brace."""
    start = text.find(anchor)
    if start < 0:
        fail(f'{rel}: could not find {anchor!r}')
    depth = 0
    for i in range(start, len(text)):
        ch = text[i]
        if ch in '{[':
            depth += 1
        elif ch in '}]':
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    fail(f'{rel}: {anchor!r} block is not closed')
    raise AssertionError('unreachable')  # pragma: no cover


def keys_of(block: str) -> set[str]:
    """Quoted command types used as object keys (`'x:y':`) in a literal block."""
    return set(re.findall(rf"['\"]({TYPE_RE})['\"]\s*:", block))


def values_of(block: str) -> set[str]:
    """Quoted command types used as values (`: 'x:y'`) in a literal block."""
    return set(re.findall(rf":\s*['\"]({TYPE_RE})['\"]", block))


def members_of(block: str) -> set[str]:
    """Quoted command types appearing as bare members of a set/array literal."""
    return set(re.findall(rf"['\"]({TYPE_RE})['\"]", block))


def main() -> int:
    problems: list[str] = []
    notes: list[str] = []

    router_src = read(ROUTER)
    schemas_src = read(SCHEMAS)
    core_src = read(DISPATCH_CORE)
    if router_src is None or schemas_src is None or core_src is None:
        fail('one of the three authoritative sites is missing; cannot check anything')
        return 2

    routes = keys_of(block_after(router_src, 'export const ROUTES', ROUTER, '}'))
    schemas = keys_of(block_after(schemas_src, 'const VALIDATORS', SCHEMAS, '}'))
    known = members_of(block_after(core_src, 'KNOWN_COMMAND_TYPES', DISPATCH_CORE, ')'))

    if not routes:
        fail(f'{ROUTER}: parsed zero command types out of ROUTES')

    def require_equal(name_a: str, a: set[str], name_b: str, b: set[str]) -> None:
        if a == b:
            return
        only_a = sorted(a - b)
        only_b = sorted(b - a)
        problems.append(
            f'{name_a} and {name_b} disagree:\n'
            + (f'  only in {name_a}: {only_a}\n' if only_a else '')
            + (f'  only in {name_b}: {only_b}\n' if only_b else '')
        )

    def require_subset(name_a: str, a: set[str], name_b: str, b: set[str]) -> None:
        extra = sorted(a - b)
        if extra:
            problems.append(f'{name_a} has types that {name_b} cannot route: {extra}\n')

    require_equal(f'{ROUTER} ROUTES', routes, f'{SCHEMAS} VALIDATORS', schemas)
    require_subset(f'{ROUTER} ROUTES', routes, f'{DISPATCH_CORE} KNOWN_COMMAND_TYPES', known)

    is_pro = (REPO_ROOT / '.sync' / 'config.json').is_file()
    if is_pro:
        require_equal(f'{ROUTER} ROUTES', routes, f'{DISPATCH_CORE} KNOWN_COMMAND_TYPES', known)
    else:
        unroutable = sorted(known - routes)
        if unroutable:
            notes.append(
                f'{DISPATCH_CORE} accepts {len(unroutable)} type(s) this edition cannot '
                f'route: {unroutable}. Their client handlers are pro-only, so the backend '
                'allowlist is a superset here by design.'
            )

    gate_src = read(GATE)
    if gate_src is None:
        notes.append(f'{GATE} not present; skipped')
    else:
        gated = members_of(block_after(gate_src, 'LI_ACTION_COMMAND_TYPES', GATE, ')'))
        require_subset(f'{GATE} LI_ACTION_COMMAND_TYPES', gated, f'{ROUTER} ROUTES', routes)

    agent_src = read(AGENT_GATE)
    if agent_src is None:
        notes.append(f'{AGENT_GATE} not present (pro-only); skipped')
    else:
        mapped = values_of(block_after(agent_src, 'COMMAND_TYPE_BY_ACTION', AGENT_GATE, '}'))
        require_subset(f'{AGENT_GATE} COMMAND_TYPE_BY_ACTION', mapped, f'{ROUTER} ROUTES', routes)

    svc_src = read(COMMAND_SERVICE)
    if svc_src is None:
        notes.append(f'{COMMAND_SERVICE} not present; skipped')
    else:
        li_actions = members_of(block_after(svc_src, 'LI_ACTION_TYPES', COMMAND_SERVICE, ')'))
        dispatchable = members_of(block_after(svc_src, 'const linkedInTypes', COMMAND_SERVICE, ']'))
        require_subset(f'{COMMAND_SERVICE} LI_ACTION_TYPES', li_actions, f'{ROUTER} ROUTES', routes)
        require_subset(f'{COMMAND_SERVICE} linkedInTypes', dispatchable, f'{ROUTER} ROUTES', routes)

    for note in notes:
        print(f'check-command-vocabulary: {note}')

    if problems:
        print('check-command-vocabulary: the command vocabulary has drifted:')
        print()
        for problem in problems:
            print(problem)
        print('The six sites are hand-mirrored. commandRouter.ts ROUTES is the authority:')
        print('a type the client cannot route is a command that is written, dispatched,')
        print('and then silently dropped.')
        return 1

    checked = 6 - sum(1 for n in notes if 'not present' in n)
    print(
        f'check-command-vocabulary: OK ({len(routes)} routable types, consistent '
        f'across {checked} sites)'
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
