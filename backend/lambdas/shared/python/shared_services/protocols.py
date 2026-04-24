"""Protocol types for service DI boundaries in shared handler utilities.

Replaces ``Any`` in ``handler_utils.py`` signatures with structural types that
document the minimum surface each injected service must provide. These are
typing-only contracts — they do not import the concrete implementations, so
they stay cheap and free of circular imports.
"""

from __future__ import annotations

from typing import Any, Protocol


class QuotaServiceProto(Protocol):
    """Subset of QuotaService used by handler utilities."""

    def report_usage(self, user_sub: str, operation: str, count: int = 1) -> None: ...


class FeatureFlagServiceProto(Protocol):
    """Subset of FeatureFlagService used by handler utilities."""

    def get_feature_flags(self, user_sub: str) -> dict[str, Any]: ...


class HandlerFn(Protocol):
    """Callable signature for per-operation handler functions.

    The four-positional-argument shape mirrors the existing HANDLERS dicts in
    edge-crud, ragstack-ops, and analytics-insights Lambdas.
    """

    def __call__(self, body: dict | None, user_id: str, event: dict, edge_cache: dict) -> dict: ...


class ServiceResolver(Protocol):
    """Zero-arg resolver returning a FeatureFlagServiceProto.

    Used by ``lazy_gated_handler`` to defer service instantiation until the
    handler is invoked (late binding for test patchability).
    """

    def __call__(self) -> FeatureFlagServiceProto | None: ...
