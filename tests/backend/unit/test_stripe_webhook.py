"""Unit tests for Stripe webhook Lambda handler."""
import os
import time
from unittest.mock import MagicMock, patch

import pytest

from conftest import load_lambda_module


@pytest.fixture
def stripe_module():
    """Load the stripe-webhook Lambda module within mocked AWS context."""
    from moto import mock_aws

    with mock_aws():
        module = load_lambda_module('stripe-webhook')
        yield module


def _reset_and_load(stripe_module, mock_boto):
    """Reset module state and load secrets using a mock boto client."""
    mock_ssm = MagicMock()
    mock_ssm.get_parameter.return_value = {
        'Parameter': {'Value': 'test-secret-value'}
    }
    mock_boto.return_value = mock_ssm
    stripe_module._stripe_secrets_loaded_at = 0
    stripe_module._load_stripe_secrets()
    return mock_ssm


class TestSSMRetryConfig:
    """Tests for SSM adaptive retry configuration."""

    def test_ssm_client_uses_adaptive_retry(self, stripe_module):
        """SSM client should be created with adaptive retry config."""
        with patch('boto3.client') as mock_boto:
            _reset_and_load(stripe_module, mock_boto)

            mock_boto.assert_called_once()
            call_args = mock_boto.call_args
            assert call_args[0][0] == 'ssm'
            config = call_args[1]['config']
            assert config.connect_timeout == 3
            assert config.read_timeout == 3
            assert config.retries == {'max_attempts': 2, 'mode': 'adaptive'}

    def test_existing_timeouts_preserved(self, stripe_module):
        """SSM client should preserve connect_timeout=3 and read_timeout=3."""
        with patch('boto3.client') as mock_boto:
            _reset_and_load(stripe_module, mock_boto)

            config = mock_boto.call_args[1]['config']
            assert config.connect_timeout == 3
            assert config.read_timeout == 3


class TestSSMSecretTTL:
    """Tests for 5-minute TTL refresh of cached Stripe secrets."""

    def test_first_call_loads_secrets(self, stripe_module):
        """First call should load secrets from SSM."""
        with patch('boto3.client') as mock_boto:
            mock_ssm = _reset_and_load(stripe_module, mock_boto)

            # SSM get_parameter should be called twice (key + webhook secret)
            assert mock_ssm.get_parameter.call_count == 2

    def test_second_call_within_ttl_skips_ssm(self, stripe_module):
        """Second call within 5 minutes should NOT call SSM again."""
        with patch('boto3.client') as mock_boto:
            mock_ssm = _reset_and_load(stripe_module, mock_boto)

            # Reset mock to track only the second call
            mock_boto.reset_mock()
            mock_ssm.reset_mock()

            # Call again - should return immediately
            stripe_module._load_stripe_secrets()

            mock_boto.assert_not_called()
            mock_ssm.get_parameter.assert_not_called()

    def test_call_after_ttl_reloads_secrets(self, stripe_module):
        """Call after 5 minutes should reload secrets from SSM."""
        with patch('boto3.client') as mock_boto:
            mock_ssm = _reset_and_load(stripe_module, mock_boto)

            # Simulate time passing beyond the TTL (5 minutes)
            stripe_module._stripe_secrets_loaded_at = time.time() - 301

            mock_boto.reset_mock()
            mock_ssm2 = MagicMock()
            mock_ssm2.get_parameter.return_value = {
                'Parameter': {'Value': 'refreshed-secret'}
            }
            mock_boto.return_value = mock_ssm2

            stripe_module._load_stripe_secrets()

            # Should have called SSM again
            mock_boto.assert_called_once()
            assert mock_ssm2.get_parameter.call_count == 2

    def test_boolean_flag_removed(self, stripe_module):
        """_stripe_api_key_loaded boolean should not exist."""
        assert not hasattr(stripe_module, '_stripe_api_key_loaded')
