"""
SSM Cached Secret Utility

Reusable TTL-cached SSM SecureString fetcher. Lazily creates the SSM client
on first access and caches the value for the configured TTL.
"""

import logging
import os
import time

import boto3
from botocore.config import Config

logger = logging.getLogger(__name__)


class SSMCachedSecret:
    """TTL-cached wrapper around SSM SecureString parameters.

    Args:
        param_name_or_arn: SSM parameter name or full ARN.
        ttl_seconds: How long to cache the value before re-fetching.
        ssm_client_config: Optional dict of boto3 Config kwargs for the SSM client.
    """

    def __init__(
        self,
        param_name_or_arn: str,
        ttl_seconds: int = 300,
        ssm_client_config: dict | None = None,
    ):
        self._param_name_or_arn = param_name_or_arn
        self._ttl_seconds = ttl_seconds
        self._ssm_client_config = ssm_client_config
        self._ssm_client = None
        self._cached_value: str | None = None
        self._loaded_at: float = 0

    def _resolve_param_name(self) -> str:
        """Convert ARN to parameter name if needed."""
        raw = self._param_name_or_arn
        if ':parameter' in raw:
            return raw.split(':parameter')[-1]
        return raw

    def _get_client(self):
        """Lazily create the SSM client."""
        if self._ssm_client is None:
            if self._ssm_client_config:
                config = Config(**self._ssm_client_config)
            else:
                config = Config(
                    connect_timeout=3,
                    read_timeout=3,
                    retries={'max_attempts': 2, 'mode': 'adaptive'},
                )
            self._ssm_client = boto3.client('ssm', config=config)
        return self._ssm_client

    def get_value(self) -> str:
        """Return the cached secret, fetching from SSM if expired."""
        now = time.time()
        if self._cached_value is not None and (now - self._loaded_at) < self._ttl_seconds:
            return self._cached_value

        client = self._get_client()
        param_name = self._resolve_param_name()
        if not param_name:
            raise ValueError('SSM parameter name is empty — check OPENAI_API_KEY_ARN environment variable')
        resp = client.get_parameter(Name=param_name, WithDecryption=True)
        self._cached_value = resp['Parameter']['Value']
        self._loaded_at = time.time()
        return self._cached_value


# One SSMCachedSecret per ARN, kept for the life of the container.
#
# resolve_secret used to construct a fresh instance per call, which threw away
# the TTL cache that class exists to provide — every call went to SSM, in a
# module named ssm_cache. Today's callers resolve at module scope so the cost is
# one GetParameter per cold start, but the abstraction was silently doing
# nothing, and the first caller to resolve per-request would have paid for it.
_SECRET_CACHE: dict[tuple[str, int], SSMCachedSecret] = {}


def _cached_secret(arn: str, ttl_seconds: int) -> SSMCachedSecret:
    key = (arn, ttl_seconds)
    if key not in _SECRET_CACHE:
        _SECRET_CACHE[key] = SSMCachedSecret(arn, ttl_seconds=ttl_seconds)
    return _SECRET_CACHE[key]


def reset_secret_cache() -> None:
    """Drop every memoized resolver. For tests only.

    A process-lifetime cache is right in a Lambda container — one ARN, one
    process, and SSMCachedSecret's own TTL handles rotation — but it makes two
    tests that resolve the same ARN share state, so one that expects a read
    failure can be served an earlier test's success instead.
    """
    _SECRET_CACHE.clear()


def resolve_secret(*, arn_env: str, fallback_env: str, label: str, ttl_seconds: int = 300) -> str:
    """Resolve a secret from SSM at runtime, falling back to a plaintext env var.

    The repo's established pattern for secrets is an SSM SecureString ARN passed
    as a template parameter plus a ``ssm:GetParameter`` grant scoped to that
    exact ARN, resolved at runtime through :class:`SSMCachedSecret` — the OpenAI
    and Stripe keys already work this way. This helper applies it to the secrets
    that did not.

    The fallback exists so the change is deploy-order-independent: an
    environment that has not yet had its ARN parameter set keeps working off the
    plaintext env var and says so in the logs. Removing the fallback is a
    follow-up once every environment carries the ARN.

    Args:
        arn_env: Env var holding the SSM parameter ARN (preferred source).
        fallback_env: Env var holding the plaintext value (legacy source).
        label: Human-readable name used in log messages only.
        ttl_seconds: Cache lifetime for the fetched value.

    Returns:
        The secret value, or ``''`` when neither source is configured. Callers
        decide whether a blank value is fatal — it is for the unsubscribe HMAC
        key, and merely disabling for the optional RAGStack integration.
    """
    arn = os.environ.get(arn_env, '').strip()
    if arn:
        # Deliberately not swallowed: if the ARN is set but unreadable, the
        # deploy is misconfigured, and silently sliding to a stale plaintext env
        # var would hide exactly the migration error this is meant to surface.
        return _cached_secret(arn, ttl_seconds).get_value()

    value = os.environ.get(fallback_env, '')
    if value:
        logger.warning(
            '%s is being read from the plaintext %s environment variable because %s is unset. '
            'Set the SSM parameter ARN so the value is fetched at runtime instead.',
            label,
            fallback_env,
            arn_env,
        )
    return value


def resolve_ragstack_api_key() -> str:
    """Return the RAGStack API key, preferring a runtime SSM fetch.

    RAGSTACK_API_KEY used to be injected as a plaintext Lambda env var, readable
    by anyone holding lambda:GetFunctionConfiguration. When RAGSTACK_API_KEY_ARN
    is set the template injects no plaintext value at all and this fetches from
    SSM instead; the env var remains as the documented fallback so an
    environment that has not yet been given the ARN keeps working.

    Note the default deployment path (DeployRAGStack=true) sources the key from
    the nested RAGStack stack's GraphQLApiKey output, which is produced at deploy
    time and has no SSM parameter to point at. That path therefore stays on the
    fallback unless an operator copies the key into an SSM SecureString and sets
    RagstackApiKeyArn. The external-endpoint path (DeployRAGStack=false) is fully
    covered.

    Unlike :func:`resolve_secret`, an SSM failure here DEGRADES rather than
    raising. Every caller resolves this at module scope and every one of them
    gates on ``if RAGSTACK_GRAPHQL_ENDPOINT and RAGSTACK_API_KEY:`` — an empty
    key already means "RAGStack is off". Letting the exception escape turned a
    transient GetParameter failure into ``Runtime.ImportModuleError``, so every
    request that container served returned 502: for edge-crud that is the whole
    connections list, notes, activity timeline and lifecycle, none of which need
    RAGStack at all. Failing loudly is right for a secret the handler cannot run
    without (the unsubscribe HMAC calls ``resolve_secret`` directly and keeps
    that contract); it is wrong for an optional integration.
    """
    try:
        return resolve_secret(
            arn_env='RAGSTACK_API_KEY_ARN',
            fallback_env='RAGSTACK_API_KEY',
            label='RAGStack API key',
        )
    except Exception:
        logger.exception(
            'Could not resolve the RAGStack API key; continuing with RAGStack disabled. '
            'Search and ingest will be unavailable until the next cold start resolves it.'
        )
        return ''
