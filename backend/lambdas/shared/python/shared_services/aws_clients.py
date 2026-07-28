"""Shared boto3 client/resource factories with explicit timeouts.

A deliberate leaf module: it imports only ``boto3`` and ``botocore.config`` and
does no I/O at load time, so every Lambda can import it at module scope without
dragging a dependency tree into its cold start.

**Why this is not in ``handler_utils``.** ``handler_utils`` imports
``shared_services.monetization`` at module scope, and two of the call sites
below must not reach that:

* ``command_dispatch_core`` is community-clean per ADR-009 — "imports nothing
  pro/agent/quota". Routing it through ``handler_utils`` would put
  ``monetization -> quota_service/tier_service/feature_flag_service`` in its
  import graph. The repo's own guard
  (``test_command_dispatch_core.test_core_imports_nothing_pro``) inspects direct
  imports only, so it would not have caught the breach.
* ``command-dispatch`` has a cold-start budget of 6 ``shared_services.*``
  modules (``test_cold_start_imports``); ``handler_utils`` and its transitive
  imports alone are more than that.
"""

import copy

import boto3
from botocore.config import Config

# Default botocore timeouts are 60s connect / 60s read, which exceed the 30s
# Timeout on most of these functions — so a hung DynamoDB call became a hard
# Lambda kill rather than a catchable, retryable error. Adaptive retries add
# client-side rate limiting on top of the standard backoff.
#
# These values match the pattern already correct in digest-coordinator,
# digest-per-user, stripe-webhook, ssm_cache, and goal_evidence_detector; the
# point of the factory is that there is now one copy of them rather than one per
# call site, which is how the pattern drifted in the first place.
DYNAMODB_CLIENT_CONFIG_KWARGS: dict = {
    'connect_timeout': 3,
    'read_timeout': 5,
    'retries': {'max_attempts': 3, 'mode': 'adaptive'},
}


def dynamodb_config() -> Config:
    """Build a **fresh** ``Config`` from the shared declaration above.

    Deliberately not a shared module-level ``Config`` instance, and deliberately
    a deep copy. botocore normalises a ``Config`` **in place** when it builds a
    client — measured: ``retries`` goes from
    ``{'max_attempts': 3, 'mode': 'adaptive'}`` to
    ``{'mode': 'adaptive', 'total_max_attempts': 4}`` on first use. A fresh
    ``Config`` alone is not enough, because ``Config(**KWARGS)`` hands botocore
    the *same nested* ``retries`` dict, which it then rewrites — so the
    declaration above would still mutate.

    The rewrite is idempotent and semantically identical (1 initial attempt + 3
    retries), so nothing misbehaved; but a constant that mutates is a trap for
    the next reader, and it made an assertion here order-dependent.
    """
    return Config(**copy.deepcopy(DYNAMODB_CLIENT_CONFIG_KWARGS))


def dynamodb_resource(**kwargs):
    """Return a boto3 DynamoDB *resource* with explicit timeouts."""
    return boto3.resource('dynamodb', config=dynamodb_config(), **kwargs)


def dynamodb_client(**kwargs):
    """Return a boto3 DynamoDB *client* with the same explicit timeouts."""
    return boto3.client('dynamodb', config=dynamodb_config(), **kwargs)


def require_table(table, env_var: str = 'DYNAMODB_TABLE_NAME'):
    """Return a lazily-built table resource, refusing an unconfigured one.

    Five handlers build their table at import as
    ``table = dynamodb_resource().Table(NAME) if NAME else None`` and then use it
    inside a broad ``except Exception``. When the name is unset that swallowed an
    ``AttributeError: 'NoneType' object has no attribute 'get_item'`` and logged it
    as whatever the caller happened to be doing — "Failed to read the resume
    cursor", say — which points at DynamoDB rather than at the missing
    configuration. Each of those handlers already rejects the unset case at its
    entrypoint, so this states the invariant the type could not, and makes the
    failure legible on the day one of them does not.
    """
    if table is None:
        raise RuntimeError(f'{env_var} is not configured; no DynamoDB table resource is available')
    return table
