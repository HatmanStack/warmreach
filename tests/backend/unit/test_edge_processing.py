"""Tests for Edge Processing Lambda"""
import json

import pytest

from conftest import load_lambda_module


@pytest.fixture
def edge_processing_module():
    """Load the edge-processing Lambda module"""
    return load_lambda_module('edge-processing')


def test_lambda_handler_unauthorized(lambda_context, edge_processing_module):
    """Test that unauthenticated requests return 401"""
    event = {
        'body': json.dumps({'data': 'test'}),
    }

    response = edge_processing_module.lambda_handler(event, lambda_context)

    assert response['statusCode'] == 401


def test_lambda_handler_with_auth(lambda_context, edge_processing_module):
    """Test authenticated request handling"""
    event = {
        'body': json.dumps({
            'profileId': 'test-profile-123',
            'operation': 'check_exists',
        }),
        'requestContext': {
            'authorizer': {
                'claims': {
                    'sub': 'test-user-123',
                }
            }
        }
    }

    response = edge_processing_module.lambda_handler(event, lambda_context)

    # EdgeService wraps ClientError as ExternalServiceError → handler returns 502
    assert response['statusCode'] == 502
    body = json.loads(response['body'])
    assert 'error' in body


def test_lambda_handler_invalid_input(lambda_context, edge_processing_module):
    """Test handling of invalid input (still requires auth)"""
    event = {
        'body': 'invalid-json{',
        'requestContext': {
            'authorizer': {
                'claims': {
                    'sub': 'test-user-123',
                }
            }
        }
    }

    response = edge_processing_module.lambda_handler(event, lambda_context)

    assert response['statusCode'] == 500
    body = json.loads(response['body'])
    assert 'error' in body
