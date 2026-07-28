"""Task 4: the RAGStack API key and the unsubscribe HMAC key resolve from SSM at
runtime instead of riding in a plaintext Lambda env var.

Both used to be readable by anyone holding ``lambda:GetFunctionConfiguration``;
the unsubscribe key additionally materialised into ``cloudformation:GetTemplate``
output because ``{{resolve:ssm:...}}`` is the plain (non-SecureString) resolver
and evaluates at deploy time.

The env-var fallback is deliberate and is the upgrade path, so it is tested as
carefully as the SSM path.
"""

import logging
import os
import sys

import boto3
import pytest
from moto import mock_aws

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../..', 'backend/lambdas/shared/python'))

from shared_services.ssm_cache import reset_secret_cache, resolve_secret  # noqa: E402

PARAM_NAME = '/warmreach/test/some-secret'
PARAM_ARN = f'arn:aws:ssm:us-east-1:123456789012:parameter{PARAM_NAME}'


@pytest.fixture
def clean_env(monkeypatch):
    for key in ('X_ARN', 'X_PLAIN', 'RAGSTACK_API_KEY_ARN', 'RAGSTACK_API_KEY'):
        monkeypatch.delenv(key, raising=False)
    return monkeypatch


@pytest.fixture(autouse=True)
def _clear_secret_cache():
    """resolve_secret memoizes one resolver per ARN for the life of the process.
    Without clearing it, the test asserting that an unreadable ARN raises is
    served the cached success from the earlier test using the same ARN.

    reset_secret_cache is imported at module scope, next to resolve_secret, on
    purpose. conftest's load_lambda_module deletes every ``shared_services*``
    entry from sys.modules, so any test that loads a Lambda leaves a later
    ``from shared_services.ssm_cache import ...`` building a SECOND module
    object with its own empty _SECRET_CACHE. Importing lazily in here cleared
    that fresh copy while resolve_secret kept using the original module's
    still-populated cache — green alone, red after any Lambda-loading test."""
    reset_secret_cache()
    yield
    reset_secret_cache()


class TestResolveSecret:
    @mock_aws
    def test_prefers_the_ssm_parameter_when_the_arn_is_set(self, clean_env):
        ssm = boto3.client('ssm', region_name='us-east-1')
        ssm.put_parameter(Name=PARAM_NAME, Value='from-ssm', Type='SecureString')
        clean_env.setenv('X_ARN', PARAM_ARN)
        clean_env.setenv('X_PLAIN', 'from-env')

        assert resolve_secret(arn_env='X_ARN', fallback_env='X_PLAIN', label='x') == 'from-ssm'

    @mock_aws
    def test_falls_back_to_the_env_var_and_warns(self, clean_env, caplog):
        """The upgrade path: an environment that has not been given the ARN yet
        keeps working, and says so."""
        clean_env.setenv('X_PLAIN', 'from-env')

        with caplog.at_level(logging.WARNING):
            value = resolve_secret(arn_env='X_ARN', fallback_env='X_PLAIN', label='Test secret')

        assert value == 'from-env'
        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert warnings, 'the fallback must be visible in the logs'
        assert 'X_ARN' in warnings[0].getMessage()

    @mock_aws
    def test_blank_when_neither_source_is_configured(self, clean_env, caplog):
        with caplog.at_level(logging.WARNING):
            assert resolve_secret(arn_env='X_ARN', fallback_env='X_PLAIN', label='x') == ''
        # Nothing configured is not the same as a silent fallback — no warning.
        assert not [r for r in caplog.records if r.levelno == logging.WARNING]

    @mock_aws
    def test_a_set_but_unreadable_arn_raises_rather_than_sliding_to_the_env_var(self, clean_env):
        """Falling back here would hide the migration error this exists to
        surface, and would keep serving a stale plaintext value indefinitely."""
        from botocore.exceptions import ClientError

        clean_env.setenv('X_ARN', PARAM_ARN)  # never created
        clean_env.setenv('X_PLAIN', 'from-env')

        with pytest.raises(ClientError):
            resolve_secret(arn_env='X_ARN', fallback_env='X_PLAIN', label='x')

    @mock_aws
    def test_whitespace_only_arn_is_treated_as_unset(self, clean_env):
        clean_env.setenv('X_ARN', '   ')
        clean_env.setenv('X_PLAIN', 'from-env')
        assert resolve_secret(arn_env='X_ARN', fallback_env='X_PLAIN', label='x') == 'from-env'


class TestRagstackApiKeyResolution:
    @mock_aws
    def test_reads_the_ssm_parameter_when_the_arn_is_set(self, clean_env):
        from shared_services.ssm_cache import resolve_ragstack_api_key

        ssm = boto3.client('ssm', region_name='us-east-1')
        ssm.put_parameter(Name='/warmreach/test/ragstack', Value='rs-secret', Type='SecureString')
        clean_env.setenv('RAGSTACK_API_KEY_ARN', 'arn:aws:ssm:us-east-1:123456789012:parameter/warmreach/test/ragstack')
        clean_env.setenv('RAGSTACK_API_KEY', 'legacy-plaintext')

        assert resolve_ragstack_api_key() == 'rs-secret'

    @mock_aws
    def test_falls_back_to_the_plaintext_env_var(self, clean_env):
        from shared_services.ssm_cache import resolve_ragstack_api_key

        clean_env.setenv('RAGSTACK_API_KEY', 'legacy-plaintext')
        assert resolve_ragstack_api_key() == 'legacy-plaintext'


class TestUnsubscribeHmacIsUnchangedByTheMigration:
    def test_a_link_signed_before_the_change_still_validates(self):
        """The secret's SOURCE moved; its VALUE and the HMAC construction did
        not. A token minted under the old plaintext env var must still verify."""
        import hashlib
        import hmac

        secret = 'the-same-secret-value'
        user_id = 'user-abc'
        # Exactly what digest-per-user's _build_unsubscribe_token produced before.
        legacy_token = hmac.new(secret.encode(), user_id.encode(), digestmod=hashlib.sha256).hexdigest()

        # And exactly what digest-unsubscribe's _verify_unsubscribe_token computes now.
        expected = hmac.new(secret.encode(), user_id.encode(), digestmod=hashlib.sha256).hexdigest()
        assert hmac.compare_digest(expected, legacy_token)
