"""Tests for SSMCachedSecret utility."""

import time
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def mock_ssm_client():
    client = MagicMock()
    client.get_parameter.return_value = {
        'Parameter': {'Value': 'sk-test-key-12345'}
    }
    return client


class TestSSMCachedSecret:
    """Tests for the SSMCachedSecret class."""

    def _load_class(self):
        from shared_services.ssm_cache import SSMCachedSecret

        return SSMCachedSecret

    def test_cache_hit_within_ttl(self, mock_ssm_client):
        """Second call within TTL returns cached value without SSM call."""
        SSMCachedSecret = self._load_class()

        with patch('boto3.client', return_value=mock_ssm_client):
            secret = SSMCachedSecret('/my/param', ttl_seconds=300)
            val1 = secret.get_value()
            val2 = secret.get_value()

        assert val1 == 'sk-test-key-12345'
        assert val2 == 'sk-test-key-12345'
        # SSM should only be called once
        assert mock_ssm_client.get_parameter.call_count == 1

    def test_cache_expiry_triggers_fresh_fetch(self, mock_ssm_client):
        """Call after TTL triggers a fresh SSM fetch."""
        SSMCachedSecret = self._load_class()

        with patch('boto3.client', return_value=mock_ssm_client):
            secret = SSMCachedSecret('/my/param', ttl_seconds=0)
            val1 = secret.get_value()
            # TTL is 0, so any subsequent call should re-fetch
            time.sleep(0.01)
            mock_ssm_client.get_parameter.return_value = {
                'Parameter': {'Value': 'sk-new-key-67890'}
            }
            val2 = secret.get_value()

        assert val1 == 'sk-test-key-12345'
        assert val2 == 'sk-new-key-67890'
        assert mock_ssm_client.get_parameter.call_count == 2

    def test_arn_parsing(self, mock_ssm_client):
        """Full ARN format is parsed to extract parameter name."""
        SSMCachedSecret = self._load_class()

        arn = 'arn:aws:ssm:us-east-1:123456789012:parameter/my/secret/key'

        with patch('boto3.client', return_value=mock_ssm_client):
            secret = SSMCachedSecret(arn, ttl_seconds=300)
            secret.get_value()

        mock_ssm_client.get_parameter.assert_called_once_with(
            Name='/my/secret/key', WithDecryption=True
        )

    def test_raw_param_name(self, mock_ssm_client):
        """Raw parameter name is passed through without modification."""
        SSMCachedSecret = self._load_class()

        with patch('boto3.client', return_value=mock_ssm_client):
            secret = SSMCachedSecret('/my/param', ttl_seconds=300)
            secret.get_value()

        mock_ssm_client.get_parameter.assert_called_once_with(
            Name='/my/param', WithDecryption=True
        )

    def test_empty_param_name_raises_value_error(self):
        """Empty parameter name raises ValueError with helpful message."""
        SSMCachedSecret = self._load_class()

        with patch('boto3.client', return_value=MagicMock()):
            secret = SSMCachedSecret('', ttl_seconds=300)
            with pytest.raises(ValueError, match='SSM parameter name is empty'):
                secret.get_value()

    def test_lazy_ssm_client_creation(self):
        """SSM client is not created until get_value() is called."""
        SSMCachedSecret = self._load_class()

        with patch('boto3.client') as mock_boto_client:
            secret = SSMCachedSecret('/my/param')
            mock_boto_client.assert_not_called()

            mock_client = MagicMock()
            mock_client.get_parameter.return_value = {
                'Parameter': {'Value': 'val'}
            }
            mock_boto_client.return_value = mock_client
            secret.get_value()
            mock_boto_client.assert_called_once()
