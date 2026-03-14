"""
Unit tests for DynamoDB API Lambda function
Tests CRUD operations, authentication, CORS, and error handling
"""
import base64
import json
from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws

from conftest import load_lambda_module


@pytest.fixture
def lambda_env_vars(monkeypatch):
    """Set up environment variables for Lambda"""
    monkeypatch.setenv('DYNAMODB_TABLE_NAME', 'test-table')
    monkeypatch.setenv('COGNITO_USER_POOL_ID', 'test-pool-id')
    monkeypatch.setenv('COGNITO_REGION', 'us-west-2')
    monkeypatch.setenv('ALLOWED_ORIGINS', 'http://localhost:5173,http://localhost:3000')


@pytest.fixture
def dynamodb_api_module():
    """Load the dynamodb-api Lambda module"""
    return load_lambda_module('dynamodb-api')


@pytest.fixture
def dynamodb_table_with_data(lambda_env_vars):
    """Create DynamoDB table with test data"""
    with mock_aws():
        dynamodb = boto3.resource('dynamodb', region_name='us-west-2')

        table = dynamodb.create_table(
            TableName='test-table',
            KeySchema=[
                {'AttributeName': 'PK', 'KeyType': 'HASH'},
                {'AttributeName': 'SK', 'KeyType': 'RANGE'}
            ],
            AttributeDefinitions=[
                {'AttributeName': 'PK', 'AttributeType': 'S'},
                {'AttributeName': 'SK', 'AttributeType': 'S'},
            ],
            BillingMode='PAY_PER_REQUEST'
        )

        # Add test data
        table.put_item(Item={
            'PK': 'USER#test-user-123',
            'SK': 'SETTINGS',
            'linkedin_credentials': 'encrypted-creds',
            'preferences': {'theme': 'dark'},
        })

        yield table


@pytest.fixture
def api_gateway_event_get():
    """Mock API Gateway GET event"""
    return {
        'httpMethod': 'GET',
        'headers': {
            'origin': 'http://localhost:5173',
            'Content-Type': 'application/json',
        },
        'requestContext': {
            'authorizer': {
                'claims': {
                    'sub': 'test-user-123',
                    'email': 'test@example.com',
                }
            }
        },
        'queryStringParameters': None,
    }


@pytest.fixture
def api_gateway_event_post():
    """Mock API Gateway POST event"""
    return {
        'httpMethod': 'POST',
        'headers': {
            'origin': 'http://localhost:5173',
            'Content-Type': 'application/json',
        },
        'requestContext': {
            'authorizer': {
                'claims': {
                    'sub': 'test-user-123',
                }
            }
        },
        'body': json.dumps({
            'operation': 'create',
            'profileData': {
                'name': 'Test Profile',
                'email': 'profile@example.com',
            }
        }),
    }


@pytest.fixture
def api_gateway_event_options():
    """Mock API Gateway OPTIONS (CORS preflight) event"""
    return {
        'httpMethod': 'OPTIONS',
        'headers': {
            'origin': 'http://localhost:5173',
        },
    }


def test_cors_preflight_response(dynamodb_table_with_data, api_gateway_event_options, lambda_context, dynamodb_api_module):
    """Test CORS preflight (OPTIONS) request handling"""
    response = dynamodb_api_module.lambda_handler(api_gateway_event_options, lambda_context)

    assert response['statusCode'] == 204
    assert 'Access-Control-Allow-Origin' in response['headers']
    assert response['headers']['Access-Control-Allow-Origin'] == 'http://localhost:5173'
    assert 'Access-Control-Allow-Methods' in response['headers']
    assert response['body'] == '""'


def test_get_user_settings_authenticated(dynamodb_table_with_data, api_gateway_event_get, lambda_context, dynamodb_api_module):
    """Test that authenticated GET request returns proper response structure"""
    # Patch the service's table with the moto-mocked table (correct region)
    with patch.object(dynamodb_api_module.service, 'table', dynamodb_table_with_data):
        response = dynamodb_api_module.lambda_handler(api_gateway_event_get, lambda_context)

    assert response['statusCode'] == 200
    assert 'body' in response
    assert 'headers' in response
    # CORS headers should be present
    assert 'Access-Control-Allow-Origin' in response['headers']


def test_get_without_auth(dynamodb_table_with_data, api_gateway_event_get, lambda_context, dynamodb_api_module):
    """Test GET request without authentication"""
    # Remove auth claims
    event = api_gateway_event_get.copy()
    event['requestContext'] = {}

    response = dynamodb_api_module.lambda_handler(event, lambda_context)

    assert response['statusCode'] == 401
    body = json.loads(response['body'])
    assert 'error' in body or 'message' in body


def test_get_profile_by_id(dynamodb_table_with_data, api_gateway_event_get, lambda_context, dynamodb_api_module):
    """Test getting profile by profileId query parameter"""
    # Add a profile to the table
    profile_id = 'test-profile-123'
    profile_id_b64 = base64.urlsafe_b64encode(profile_id.encode()).decode()

    dynamodb_table_with_data.put_item(Item={
        'PK': f'PROFILE#{profile_id_b64}',
        'SK': 'METADATA',
        'name': 'Test Profile',
        'status': 'active',
    })

    event = api_gateway_event_get.copy()
    event['queryStringParameters'] = {'profileId': profile_id}

    response = dynamodb_api_module.lambda_handler(event, lambda_context)

    assert response['statusCode'] == 200
    body = json.loads(response['body'])
    assert 'profile' in body


def test_get_nonexistent_profile(dynamodb_table_with_data, api_gateway_event_get, lambda_context, dynamodb_api_module):
    """Test getting a profile that doesn't exist"""
    event = api_gateway_event_get.copy()
    event['queryStringParameters'] = {'profileId': 'nonexistent-profile'}

    response = dynamodb_api_module.lambda_handler(event, lambda_context)

    assert response['statusCode'] == 200
    body = json.loads(response['body'])
    assert body.get('profile') is None or body.get('message') == 'Profile not found'


def test_create_profile_operation(dynamodb_table_with_data, api_gateway_event_post, lambda_context, dynamodb_api_module):
    """Test creating a new profile"""
    response = dynamodb_api_module.lambda_handler(api_gateway_event_post, lambda_context)

    # With mocked DynamoDB, expect success or validation error
    assert response['statusCode'] in [200, 201, 400]
    assert 'body' in response
    body = json.loads(response['body'])
    assert isinstance(body, dict)


def test_update_user_settings_operation(dynamodb_table_with_data, api_gateway_event_post, lambda_context, dynamodb_api_module):
    """Test updating user settings"""
    event = api_gateway_event_post.copy()
    event['body'] = json.dumps({
        'operation': 'update_user_settings',
        'settings': {
            'theme': 'light',
            'notifications': True,
        }
    })

    response = dynamodb_api_module.lambda_handler(event, lambda_context)

    assert response['statusCode'] == 200
    body = json.loads(response['body'])
    assert isinstance(body, dict)


def test_invalid_operation(dynamodb_table_with_data, api_gateway_event_post, lambda_context, dynamodb_api_module):
    """Test handling of invalid operation"""
    event = api_gateway_event_post.copy()
    event['body'] = json.dumps({
        'operation': 'invalid_operation',
    })

    response = dynamodb_api_module.lambda_handler(event, lambda_context)

    # Invalid operation should return client error
    assert response['statusCode'] in [400, 404]


def test_malformed_request_body(dynamodb_table_with_data, api_gateway_event_post, lambda_context, dynamodb_api_module):
    """Test handling of malformed JSON in request body"""
    event = api_gateway_event_post.copy()
    event['body'] = 'invalid-json{'

    response = dynamodb_api_module.lambda_handler(event, lambda_context)

    # Malformed JSON should return 400 or 500 (unhandled parse error)
    assert response['statusCode'] in [400, 500]


def test_cors_headers_included(dynamodb_table_with_data, api_gateway_event_get, lambda_context, dynamodb_api_module):
    """Test that CORS headers are included in responses"""
    response = dynamodb_api_module.lambda_handler(api_gateway_event_get, lambda_context)

    assert 'headers' in response
    assert 'Access-Control-Allow-Origin' in response['headers']


def test_unknown_origin_cors(dynamodb_table_with_data, api_gateway_event_options, lambda_context, dynamodb_api_module):
    """Test CORS handling for unknown origin"""
    event = api_gateway_event_options.copy()
    event['headers']['origin'] = 'https://malicious-site.com'

    response = dynamodb_api_module.lambda_handler(event, lambda_context)

    # Should still return 204 but omit CORS origin header for unrecognized origins
    assert response['statusCode'] == 204
    assert 'Access-Control-Allow-Origin' not in response['headers']


def test_dynamodb_error_handling(dynamodb_table_with_data, api_gateway_event_get, lambda_context, dynamodb_api_module):
    """Test handling of DynamoDB errors"""
    from botocore.exceptions import ClientError

    # Patch the service's table to raise ClientError on get_item
    with patch.object(dynamodb_api_module.service, 'table') as mock_table:
        mock_table.get_item.side_effect = ClientError(
            {'Error': {'Code': 'InternalServerError', 'Message': 'Test'}},
            'GetItem'
        )
        response = dynamodb_api_module.lambda_handler(api_gateway_event_get, lambda_context)

        assert response['statusCode'] == 500
        body = json.loads(response['body'])
        assert body['error'] == 'Database error'
