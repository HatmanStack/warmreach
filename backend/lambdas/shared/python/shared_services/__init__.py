"""Service layer base classes and utilities.

Uses PEP 562 module-level ``__getattr__`` for lazy service imports. Community
edition only re-exports the two core services; importing ``shared_services``
alone costs only this file.
"""

from __future__ import annotations

import importlib
from typing import Any

_LAZY_EXPORTS: dict[str, tuple[str, str]] = {
    'BaseService': ('.base_service', 'BaseService'),
    'WebSocketService': ('.websocket_service', 'WebSocketService'),
}

__all__ = sorted(_LAZY_EXPORTS.keys())


def __getattr__(name: str) -> Any:
    try:
        module_name, symbol = _LAZY_EXPORTS[name]
    except KeyError as e:
        raise AttributeError(f'module {__name__!r} has no attribute {name!r}') from e
    module = importlib.import_module(module_name, package=__name__)
    value = getattr(module, symbol)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(set(list(globals().keys()) + list(_LAZY_EXPORTS.keys())))
