"""
SSM Cached Secret Utility

Reusable TTL-cached SSM SecureString fetcher. Lazily creates the SSM client
on first access and caches the value for the configured TTL.
"""

import time

import boto3
from botocore.config import Config


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
