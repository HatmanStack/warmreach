"""Cold-start import budget test for hot Lambda handlers.

Per Phase-4 Task 8, we measure the transitive import footprint of each hot
handler in a fresh subprocess so module caching cannot mask the count. The
ceilings below are absolute numbers — they represent the number of
``shared_services.*`` submodules pulled in when the handler module is
loaded. If you add a heavy new shared service to the top of a handler, this
test will fail and you should consider deferring that import into the
request code path instead.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2].parent
SHARED_PY = REPO_ROOT / 'backend' / 'lambdas' / 'shared' / 'python'
ERRORS_PKG = SHARED_PY  # errors/ lives here too

# Map handler-path-fragment -> ceiling on number of shared_services.* submodules
# imported at module load time. Ceilings were chosen as the actual post-Phase-4
# baseline plus a small cushion (see commit message for raw numbers). Keep
# these tight; raise them only with an accompanying note in the PR body
# explaining why the new service cannot be deferred.
HOT_HANDLERS: dict[str, int] = {
    'backend/lambdas/command-dispatch': 6,
    'backend/lambdas/llm': 10,
    'backend/lambdas/ragstack-ops': 19,
    'backend/lambdas/dynamodb-api': 17,
    'backend/lambdas/analytics-insights': 15,
    'backend/lambdas/edge-crud': 22,
}


def _count_shared_service_modules(handler_dir: Path) -> tuple[int, list[str]]:
    """Return (count, sorted_module_list) of shared_services.* modules
    imported when ``handler_dir/lambda_function.py`` loads in a fresh
    interpreter. Uses a subprocess so the parent test process' sys.modules
    cache does not interfere."""
    env = os.environ.copy()
    env['DYNAMODB_TABLE_NAME'] = 'test-table'
    env['ALLOWED_ORIGINS'] = 'http://localhost:5173'
    # Prepend the handler dir + shared python tree so imports resolve.
    pythonpath_entries = [str(handler_dir), str(SHARED_PY)]
    # Prepend services dir if present (llm has lambda-local services/)
    services_dir = handler_dir / 'services'
    if services_dir.is_dir():
        pythonpath_entries.insert(0, str(handler_dir))
    env['PYTHONPATH'] = os.pathsep.join([*pythonpath_entries, env.get('PYTHONPATH', '')])

    script = (
        'import sys, json\n'
        'before = set(sys.modules)\n'
        'try:\n'
        '    import lambda_function  # noqa: F401\n'
        'except Exception as e:\n'
        '    print(json.dumps({"error": repr(e)}))\n'
        '    raise\n'
        'after = set(sys.modules)\n'
        'ss_modules = sorted(m for m in (after - before) if m.startswith("shared_services."))\n'
        'print(json.dumps({"modules": ss_modules}))\n'
    )

    result = subprocess.run(
        [sys.executable, '-c', script],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(handler_dir),
        timeout=60,
    )
    if result.returncode != 0:
        pytest.fail(
            f'Handler import failed for {handler_dir}:\n'
            f'stdout={result.stdout}\nstderr={result.stderr}'
        )
    # The JSON line is the last non-empty stdout line.
    last_line = [ln for ln in result.stdout.strip().splitlines() if ln.strip()][-1]
    import json
    parsed = json.loads(last_line)
    if 'error' in parsed:
        pytest.fail(f'Handler import error: {parsed["error"]}')
    mods = parsed['modules']
    return len(mods), mods


@pytest.mark.parametrize('handler_rel,ceiling', sorted(HOT_HANDLERS.items()))
def test_cold_start_import_budget(handler_rel: str, ceiling: int) -> None:
    """Each hot handler imports no more than ``ceiling`` shared_services.* modules."""
    handler_dir = REPO_ROOT / handler_rel
    assert (handler_dir / 'lambda_function.py').exists(), f'missing {handler_dir}/lambda_function.py'

    count, mods = _count_shared_service_modules(handler_dir)
    assert count <= ceiling, (
        f'{handler_rel} imports {count} shared_services.* modules at load time '
        f'(ceiling={ceiling}). Loaded:\n  - ' + '\n  - '.join(mods)
    )


def test_shared_services_init_is_lazy() -> None:
    """``import shared_services`` alone must not pull in any service modules."""
    env = os.environ.copy()
    env['PYTHONPATH'] = os.pathsep.join([str(SHARED_PY), env.get('PYTHONPATH', '')])

    script = (
        'import sys, json\n'
        'before = set(sys.modules)\n'
        'import shared_services  # noqa: F401\n'
        'after = set(sys.modules)\n'
        'sub = sorted(m for m in (after - before) if m.startswith("shared_services.") and m != "shared_services.")\n'
        'print(json.dumps({"submodules": sub}))\n'
    )
    result = subprocess.run(
        [sys.executable, '-c', script],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    last_line = [ln for ln in result.stdout.strip().splitlines() if ln.strip()][-1]
    import json
    submodules = json.loads(last_line)['submodules']
    assert submodules == [], (
        f'`import shared_services` should not eagerly load submodules, '
        f'but it loaded: {submodules}'
    )
