"""Tests for WebSocket $connect handler."""

import os
from pathlib import Path
from unittest.mock import patch

import pytest
from moto import mock_aws

# Setup paths
BACKEND_LAMBDAS = Path(__file__).parent.parent.parent.parent / 'backend' / 'lambdas'
SHARED_PYTHON = BACKEND_LAMBDAS / 'shared' / 'python'

os.environ['DYNAMODB_TABLE_NAME'] = 'test-table'
os.environ['COGNITO_USER_POOL_ID'] = 'us-east-1_TestPool'
os.environ['COGNITO_REGION'] = 'us-east-1'
os.environ['WEBSOCKET_ENDPOINT'] = 'https://test.execute-api.us-east-1.amazonaws.com/dev'
os.environ['LOG_LEVEL'] = 'DEBUG'


def _make_connect_event(connection_id='conn-123', token='valid-token', client_type='browser'):
    qs = {'token': token}
    if client_type:
        qs['clientType'] = client_type
    return {
        'requestContext': {
            'connectionId': connection_id,
            'routeKey': '$connect',
        },
        'queryStringParameters': qs,
        'headers': {},
    }


@pytest.fixture
def ws_table(aws_credentials):
    with mock_aws():
        import boto3
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        table = dynamodb.create_table(
            TableName='test-table',
            KeySchema=[
                {'AttributeName': 'PK', 'KeyType': 'HASH'},
                {'AttributeName': 'SK', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'PK', 'AttributeType': 'S'},
                {'AttributeName': 'SK', 'AttributeType': 'S'},
                {'AttributeName': 'GSI1PK', 'AttributeType': 'S'},
                {'AttributeName': 'GSI1SK', 'AttributeType': 'S'},
            ],
            GlobalSecondaryIndexes=[
                {
                    'IndexName': 'GSI1',
                    'KeySchema': [
                        {'AttributeName': 'GSI1PK', 'KeyType': 'HASH'},
                        {'AttributeName': 'GSI1SK', 'KeyType': 'RANGE'},
                    ],
                    'Projection': {'ProjectionType': 'ALL'},
                    'ProvisionedThroughput': {
                        'ReadCapacityUnits': 5,
                        'WriteCapacityUnits': 5,
                    },
                }
            ],
            ProvisionedThroughput={'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5},
        )
        yield table


@pytest.fixture
def load_connect_module():
    """Load the websocket-connect Lambda with proper isolation."""
    from conftest import load_lambda_module
    return load_lambda_module('websocket-connect')


class TestWebSocketConnect:
    def test_missing_token_returns_401(self, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-connect')

        event = _make_connect_event(token=None)
        event['queryStringParameters'] = {}

        with patch.object(module, '_validate_jwt', return_value=None):
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 401

    def test_invalid_token_returns_401(self, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-connect')

        event = _make_connect_event(token='bad-token')

        with patch.object(module, '_validate_jwt', return_value=None):
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 401

    def test_invalid_client_type_returns_400(self, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-connect')

        event = _make_connect_event(client_type='invalid')
        result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 400

    def test_valid_connect_stores_connection(self, ws_table, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-connect')

        event = _make_connect_event(connection_id='conn-abc', client_type='agent')
        claims = {'sub': 'user-123', 'iss': 'test'}

        with patch.object(module, '_validate_jwt', return_value=claims), \
             patch.object(module, 'table', ws_table):
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 200

        # Verify DDB item
        item = ws_table.get_item(
            Key={'PK': 'WSCONN#conn-abc', 'SK': '#METADATA'}
        ).get('Item')
        assert item is not None
        assert item['userSub'] == 'user-123'
        assert item['clientType'] == 'agent'
        assert item['GSI1PK'] == 'USER#user-123#WSCONN'
        assert item['GSI1SK'] == 'TYPE#agent'

    def test_single_client_enforcement(self, ws_table, lambda_context):
        """Second connection of same type should disconnect the first."""
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-connect')

        # Pre-populate an existing connection
        ws_table.put_item(Item={
            'PK': 'WSCONN#old-conn',
            'SK': '#METADATA',
            'GSI1PK': 'USER#user-123#WSCONN',
            'GSI1SK': 'TYPE#browser',
            'connectionId': 'old-conn',
            'userSub': 'user-123',
            'clientType': 'browser',
            'connectedAt': 1000,
        })

        event = _make_connect_event(connection_id='new-conn', client_type='browser')
        claims = {'sub': 'user-123'}

        with patch.object(module, '_validate_jwt', return_value=claims), \
             patch.object(module, 'table', ws_table):
            # Mock the WebSocketService to avoid calling actual API Gateway
            with patch('shared_services.websocket_service.WebSocketService.disconnect_connection'):
                result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 200

        # New connection should exist
        new_item = ws_table.get_item(
            Key={'PK': 'WSCONN#new-conn', 'SK': '#METADATA'}
        ).get('Item')
        assert new_item is not None
        assert new_item['userSub'] == 'user-123'


def _generate_test_jwks():
    """Generate an RSA key pair and return (private_key, jwks_dict, kid)."""
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.backends import default_backend
    import jwt as pyjwt
    import json

    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
        backend=default_backend(),
    )
    public_key = private_key.public_key()
    kid = 'test-key-1'

    # Build JWKS
    jwk_dict = json.loads(pyjwt.algorithms.RSAAlgorithm.to_jwk(public_key))
    jwk_dict['kid'] = kid
    jwk_dict['use'] = 'sig'
    jwks = {'keys': [jwk_dict]}

    return private_key, jwks, kid


class TestValidateJwt:
    def test_valid_token_returns_claims(self):
        from conftest import load_lambda_module
        import jwt as pyjwt
        import time
        module = load_lambda_module('websocket-connect')
        private_key, jwks, kid = _generate_test_jwks()

        token = pyjwt.encode(
            {
                'sub': 'user-123',
                'iss': 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool',
                'exp': int(time.time()) + 3600,
            },
            private_key,
            algorithm='RS256',
            headers={'kid': kid}
        )

        with patch.object(module, '_get_jwks_client', return_value=jwks):
            claims = module._validate_jwt(token)

        assert claims is not None
        assert claims['sub'] == 'user-123'

    def test_expired_token_returns_none(self):
        from conftest import load_lambda_module
        import jwt as pyjwt
        import time
        module = load_lambda_module('websocket-connect')
        private_key, jwks, kid = _generate_test_jwks()

        token = pyjwt.encode(
            {
                'sub': 'user-123',
                'iss': 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool',
                'exp': int(time.time()) - 3600,
            },
            private_key,
            algorithm='RS256',
            headers={'kid': kid}
        )

        with patch.object(module, '_get_jwks_client', return_value=jwks):
            claims = module._validate_jwt(token)

        assert claims is None

    def test_wrong_issuer_returns_none(self):
        from conftest import load_lambda_module
        import jwt as pyjwt
        import time
        module = load_lambda_module('websocket-connect')
        private_key, jwks, kid = _generate_test_jwks()

        token = pyjwt.encode(
            {
                'sub': 'user-123',
                'iss': 'https://wrong-issuer.com',
                'exp': int(time.time()) + 3600,
            },
            private_key,
            algorithm='RS256',
            headers={'kid': kid}
        )

        with patch.object(module, '_get_jwks_client', return_value=jwks):
            claims = module._validate_jwt(token)

        assert claims is None

    def test_invalid_signature_returns_none(self):
        from conftest import load_lambda_module
        import jwt as pyjwt
        import time
        module = load_lambda_module('websocket-connect')
        private_key, jwks, kid = _generate_test_jwks()

        # Sign with a different key
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.hazmat.backends import default_backend
        wrong_private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=2048,
            backend=default_backend(),
        )

        token = pyjwt.encode(
            {
                'sub': 'user-123',
                'iss': 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool',
                'exp': int(time.time()) + 3600,
            },
            wrong_private_key,
            algorithm='RS256',
            headers={'kid': kid}
        )

        with patch.object(module, '_get_jwks_client', return_value=jwks):
            claims = module._validate_jwt(token)

        assert claims is None

    def test_unmatched_kid_returns_none(self):
        from conftest import load_lambda_module
        import jwt as pyjwt
        import time
        module = load_lambda_module('websocket-connect')
        private_key, jwks, kid = _generate_test_jwks()

        token = pyjwt.encode(
            {
                'sub': 'user-123',
                'iss': 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool',
                'exp': int(time.time()) + 3600,
            },
            private_key,
            algorithm='RS256',
            headers={'kid': 'wrong-kid'}
        )

        with patch.object(module, '_get_jwks_client', return_value=jwks):
            claims = module._validate_jwt(token)

        assert claims is None

    def test_missing_kid_in_header_returns_none(self):
        from conftest import load_lambda_module
        import jwt as pyjwt
        import time
        module = load_lambda_module('websocket-connect')
        private_key, jwks, kid = _generate_test_jwks()

        token = pyjwt.encode(
            {
                'sub': 'user-123',
                'iss': 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool',
                'exp': int(time.time()) + 3600,
            },
            private_key,
            algorithm='RS256'
            # headers={'kid': ...} is omitted
        )

        with patch.object(module, '_get_jwks_client', return_value=jwks):
            claims = module._validate_jwt(token)

        assert claims is None

    def test_alg_none_rejected(self):
        from conftest import load_lambda_module
        import jwt as pyjwt
        import time
        module = load_lambda_module('websocket-connect')
        private_key, jwks, kid = _generate_test_jwks()

        # Craft alg=none token
        token = pyjwt.encode(
            {
                'sub': 'user-123',
                'iss': 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool',
                'exp': int(time.time()) + 3600,
            },
            None,
            algorithm=None
        )

        with patch.object(module, '_get_jwks_client', return_value=jwks):
            claims = module._validate_jwt(token)

        assert claims is None

    def test_valid_token_with_matching_client_id(self):
        """Valid JWT with matching client_id should succeed."""
        from conftest import load_lambda_module
        import jwt as pyjwt
        import time
        module = load_lambda_module('websocket-connect')
        private_key, jwks, kid = _generate_test_jwks()

        token = pyjwt.encode(
            {
                'sub': 'user-123',
                'client_id': 'test-client-id',
                'iss': 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool',
                'exp': int(time.time()) + 3600,
            },
            private_key,
            algorithm='RS256',
            headers={'kid': kid}
        )

        with patch.object(module, '_get_jwks_client', return_value=jwks), \
             patch.dict(os.environ, {'COGNITO_CLIENT_ID': 'test-client-id'}):
            claims = module._validate_jwt(token)

        assert claims is not None
        assert claims['sub'] == 'user-123'

    def test_valid_token_with_wrong_client_id_returns_none(self):
        """Valid JWT with wrong client_id should return None."""
        from conftest import load_lambda_module
        import jwt as pyjwt
        import time
        module = load_lambda_module('websocket-connect')
        private_key, jwks, kid = _generate_test_jwks()

        token = pyjwt.encode(
            {
                'sub': 'user-123',
                'client_id': 'wrong-client-id',
                'iss': 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool',
                'exp': int(time.time()) + 3600,
            },
            private_key,
            algorithm='RS256',
            headers={'kid': kid}
        )

        with patch.object(module, '_get_jwks_client', return_value=jwks), \
             patch.dict(os.environ, {'COGNITO_CLIENT_ID': 'expected-client-id'}):
            claims = module._validate_jwt(token)

        assert claims is None

    def test_valid_token_without_client_id_check_succeeds(self):
        """Valid JWT should succeed when COGNITO_CLIENT_ID env var is not set (backward compat)."""
        from conftest import load_lambda_module
        import jwt as pyjwt
        import time
        module = load_lambda_module('websocket-connect')
        private_key, jwks, kid = _generate_test_jwks()

        token = pyjwt.encode(
            {
                'sub': 'user-123',
                'client_id': 'any-client-id',
                'iss': 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool',
                'exp': int(time.time()) + 3600,
            },
            private_key,
            algorithm='RS256',
            headers={'kid': kid}
        )

        env_copy = os.environ.copy()
        env_copy.pop('COGNITO_CLIENT_ID', None)

        with patch.object(module, '_get_jwks_client', return_value=jwks), \
             patch.dict(os.environ, env_copy, clear=True):
            claims = module._validate_jwt(token)

        assert claims is not None
        assert claims['sub'] == 'user-123'


class TestJwksCache:
    """JWKS caching: TTL reuse, stale-on-failure fallback, 500 on no-cache failure."""

    def _reset_cache(self, module):
        module._JWKS_CACHE['data'] = None
        module._JWKS_CACHE['fetched_at'] = 0.0

    def test_first_call_fetches(self):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-connect')
        self._reset_cache(module)
        sample = {'keys': [{'kid': 'k1'}]}

        with patch.object(module, 'fetch_jwks', return_value=sample) as mocked:
            result = module._get_jwks_client()

        assert result == sample
        assert mocked.call_count == 1

    def test_second_call_within_ttl_uses_cache(self):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-connect')
        self._reset_cache(module)
        sample = {'keys': [{'kid': 'k1'}]}

        with patch.object(module, 'fetch_jwks', return_value=sample) as mocked:
            module._get_jwks_client()
            module._get_jwks_client()

        assert mocked.call_count == 1

    def test_expired_ttl_refetches(self):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-connect')
        self._reset_cache(module)
        module._JWKS_CACHE['data'] = {'keys': [{'kid': 'stale'}]}
        # Simulate a fetch that happened long ago (older than TTL).
        module._JWKS_CACHE['fetched_at'] = 0.0

        fresh = {'keys': [{'kid': 'fresh'}]}
        with patch.object(module, 'fetch_jwks', return_value=fresh) as mocked:
            result = module._get_jwks_client()

        assert result == fresh
        assert mocked.call_count == 1

    def test_fetch_failure_with_cache_serves_stale(self):
        from conftest import load_lambda_module
        import time as _time
        module = load_lambda_module('websocket-connect')
        self._reset_cache(module)
        stale = {'keys': [{'kid': 'stale'}]}
        # Prime cache with something older than TTL but within stale grace.
        module._JWKS_CACHE['data'] = stale
        module._JWKS_CACHE['fetched_at'] = _time.time() - (module._JWKS_TTL_SECONDS + 60)

        with patch.object(module, 'fetch_jwks', side_effect=RuntimeError('net')):
            result = module._get_jwks_client()

        assert result == stale

    def test_fetch_failure_without_cache_raises(self):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-connect')
        self._reset_cache(module)

        with patch.object(module, 'fetch_jwks', side_effect=RuntimeError('net')):
            with pytest.raises(module.JWKSUnavailableError):
                module._get_jwks_client()

    def test_fetch_jwks_retries_once(self):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-connect')
        import urllib.request as urlreq

        call_counter = {'n': 0}

        class _FakeResp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                import json as _json
                return _json.dumps({'keys': []}).encode()

        def fake_urlopen(url, timeout=None):
            call_counter['n'] += 1
            if call_counter['n'] == 1:
                raise RuntimeError('transient')
            return _FakeResp()

        with patch.object(urlreq, 'urlopen', side_effect=fake_urlopen):
            result = module.fetch_jwks()

        assert result == {'keys': []}
        assert call_counter['n'] == 2

    def test_handler_returns_500_on_jwks_unavailable(self, lambda_context):
        from conftest import load_lambda_module
        module = load_lambda_module('websocket-connect')

        event = _make_connect_event()

        def raise_unavailable(_token):
            raise module.JWKSUnavailableError('fetch failed')

        with patch.object(module, '_validate_jwt', side_effect=raise_unavailable):
            result = module.lambda_handler(event, lambda_context)

        assert result['statusCode'] == 500
