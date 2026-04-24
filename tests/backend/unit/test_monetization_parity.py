"""Parity test between monetization.py (pro) and monetization_stubs.py (community overlay).

ADR-E: Every symbol exported by the pro monetization module must also be
exported by the community stubs with a compatible signature. Prevents silent
community-edition divergence when a new billing surface is added.
"""

import importlib
import inspect

import pytest


def _public_names(module) -> set[str]:
    if hasattr(module, '__all__'):
        return set(module.__all__)
    return {name for name in dir(module) if not name.startswith('_')}


def _public_callables(module) -> dict[str, object]:
    names = _public_names(module)
    return {name: getattr(module, name) for name in names if callable(getattr(module, name, None))}


@pytest.fixture(scope='module')
def pro_module():
    return importlib.import_module('shared_services.monetization')


@pytest.fixture(scope='module')
def stubs_module():
    return importlib.import_module('shared_services.monetization_stubs')


def test_stubs_export_every_pro_symbol(pro_module, stubs_module):
    pro_names = _public_names(pro_module)
    stub_names = _public_names(stubs_module)
    # Stubs may export extras (e.g. re-exports for isinstance safety); pro must
    # be a subset.
    missing = pro_names - stub_names
    assert not missing, (
        f'monetization_stubs.py is missing exports present in monetization.py: {sorted(missing)}. '
        'When adding a symbol to the pro module, add a no-op counterpart to monetization_stubs.py '
        'and update .sync/overlays/backend/lambdas/shared/python/shared_services/monetization.py '
        'to keep the community edition compilable.'
    )


def test_callable_signatures_match(pro_module, stubs_module):
    """Every callable shared between pro and stubs must have the same parameter names.

    Parameter kinds (positional vs keyword-only) and defaults are not strictly
    compared to allow stubs to default generously; only parameter *names* must
    match so call sites do not drift.
    """
    pro_callables = _public_callables(pro_module)
    stub_callables = _public_callables(stubs_module)

    mismatches: list[str] = []
    for name, pro_obj in pro_callables.items():
        if name not in stub_callables:
            continue  # Caught by test above.

        stub_obj = stub_callables[name]

        if inspect.isclass(pro_obj) and inspect.isclass(stub_obj):
            # For classes, compare the public method surface.
            pro_methods = {
                m for m in dir(pro_obj) if not m.startswith('_') and callable(getattr(pro_obj, m, None))
            }
            stub_methods = {
                m for m in dir(stub_obj) if not m.startswith('_') and callable(getattr(stub_obj, m, None))
            }
            missing_methods = pro_methods - stub_methods
            if missing_methods:
                mismatches.append(
                    f'{name}: stub class missing methods {sorted(missing_methods)}'
                )
                continue

            # Also compare __init__ and each shared method's parameters.
            for method_name in pro_methods & stub_methods:
                try:
                    pro_sig = inspect.signature(getattr(pro_obj, method_name))
                    stub_sig = inspect.signature(getattr(stub_obj, method_name))
                except (TypeError, ValueError):
                    continue
                pro_params = [p.name for p in pro_sig.parameters.values()]
                stub_params = [p.name for p in stub_sig.parameters.values()]
                if pro_params != stub_params:
                    mismatches.append(
                        f'{name}.{method_name}: pro params {pro_params} != stub params {stub_params}'
                    )
            # __init__ is handled via signature(class).
            try:
                pro_sig = inspect.signature(pro_obj)
                stub_sig = inspect.signature(stub_obj)
                pro_params = [p.name for p in pro_sig.parameters.values()]
                stub_params = [p.name for p in stub_sig.parameters.values()]
                if pro_params != stub_params:
                    mismatches.append(
                        f'{name}.__init__: pro params {pro_params} != stub params {stub_params}'
                    )
            except (TypeError, ValueError):
                pass
        else:
            try:
                pro_sig = inspect.signature(pro_obj)
                stub_sig = inspect.signature(stub_obj)
            except (TypeError, ValueError):
                continue
            pro_params = [p.name for p in pro_sig.parameters.values()]
            stub_params = [p.name for p in stub_sig.parameters.values()]
            if pro_params != stub_params:
                mismatches.append(
                    f'{name}: pro params {pro_params} != stub params {stub_params}'
                )

    assert not mismatches, 'Signature drift detected:\n' + '\n'.join(mismatches)
