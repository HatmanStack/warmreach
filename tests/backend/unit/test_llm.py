"""Handler-level tests for LLM Lambda function."""
import json
from unittest.mock import MagicMock, patch

import pytest

from conftest import load_lambda_module


@pytest.fixture
def llm_module():
    """Load the LLM Lambda module."""
    return load_lambda_module('llm')


@pytest.fixture
def mock_services(llm_module):
    """Replace module-level quota and feature flag services with mocks."""
    mock_quota = MagicMock()
    mock_quota.report_usage.return_value = None
    mock_ff = MagicMock()
    mock_ff.get_feature_flags.return_value = {
        'tier': 'paid',
        'features': {'deep_research': True, 'ai_messaging': True},
        'quotas': {},
        'rateLimits': {},
    }

    orig_quota = llm_module._quota_service
    orig_ff = llm_module._feature_flag_service
    llm_module._quota_service = mock_quota
    llm_module._feature_flag_service = mock_ff
    yield {'quota': mock_quota, 'feature_flags': mock_ff}
    llm_module._quota_service = orig_quota
    llm_module._feature_flag_service = orig_ff


def test_unauthorized_returns_401(lambda_context, llm_module):
    """Unauthenticated requests return 401."""
    event = {
        'body': json.dumps({'operation': 'generate_ideas'}),
    }
    response = llm_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 401
    body = json.loads(response['body'])
    assert body['error'] == 'Unauthorized'


def test_invalid_operation_returns_400(lambda_context, llm_module):
    """Invalid operation returns 400."""
    event = {
        'body': json.dumps({'operation': 'nonexistent'}),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    response = llm_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 400
    body = json.loads(response['body'])
    assert body['error'] == 'Invalid operation'


def test_options_preflight_returns_200(lambda_context, llm_module):
    """OPTIONS preflight returns 200."""
    event = {
        'requestContext': {
            'http': {'method': 'OPTIONS'},
        },
    }
    response = llm_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 200


def test_missing_job_id_returns_400(lambda_context, llm_module, mock_services):
    """generate_ideas without job_id returns 400."""
    event = {
        'body': json.dumps({'operation': 'generate_ideas'}),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    response = llm_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 400
    body = json.loads(response['body'])
    assert 'job_id' in body['error']


def test_generate_message_missing_topic_returns_400(lambda_context, llm_module, mock_services):
    """generate_message without conversationTopic returns 400."""
    event = {
        'body': json.dumps({
            'operation': 'generate_message',
            'connectionProfile': {'firstName': 'A', 'lastName': 'B', 'position': 'X', 'company': 'Y'},
        }),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    response = llm_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 400
    body = json.loads(response['body'])
    assert 'conversationTopic' in body['error']


def test_generate_message_missing_profile_returns_400(lambda_context, llm_module, mock_services):
    """generate_message without connectionProfile returns 400."""
    event = {
        'body': json.dumps({
            'operation': 'generate_message',
            'conversationTopic': 'AI trends',
        }),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    response = llm_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 400
    body = json.loads(response['body'])
    assert 'connectionProfile' in body['error']


def test_quota_exceeded_returns_429(lambda_context, llm_module, mock_services):
    """When quota service raises QuotaExceededError, return 429."""
    from errors.exceptions import QuotaExceededError

    mock_services['quota'].report_usage.side_effect = QuotaExceededError(
        message='Daily limit reached', operation='generate_message'
    )
    event = {
        'body': json.dumps({
            'operation': 'generate_message',
            'conversationTopic': 'AI trends',
            'connectionProfile': {'firstName': 'A', 'lastName': 'B', 'position': 'X', 'company': 'Y'},
        }),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    with patch.object(llm_module, 'LLMService') as MockSvc:
        MockSvc.return_value.generate_message.return_value = {'message': 'Hello'}
        response = llm_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 429
    body = json.loads(response['body'])
    assert body['code'] == 'QUOTA_EXCEEDED'
    assert body['error'] == 'Daily limit reached'


def test_feature_gated_returns_403(lambda_context, llm_module, mock_services):
    """When deep_research feature is disabled, deep research ops return 403."""
    mock_services['feature_flags'].get_feature_flags.return_value = {
        'tier': 'free',
        'features': {'deep_research': False},
        'quotas': {},
        'rateLimits': {},
    }
    event = {
        'body': json.dumps({
            'operation': 'research_selected_ideas',
            'user_profile': {},
            'selected_ideas': [],
        }),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    response = llm_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 403
    body = json.loads(response['body'])
    assert body['code'] == 'FEATURE_GATED'
    assert body['feature'] == 'deep_research'


def test_feature_gated_synthesize_returns_403(lambda_context, llm_module, mock_services):
    """synthesize_research is also gated behind deep_research feature."""
    mock_services['feature_flags'].get_feature_flags.return_value = {
        'tier': 'free',
        'features': {'deep_research': False},
        'quotas': {},
        'rateLimits': {},
    }
    event = {
        'body': json.dumps({
            'operation': 'synthesize_research',
            'job_id': 'test-job',
        }),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    response = llm_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 403


def test_non_metered_op_skips_usage_report(lambda_context, llm_module, mock_services):
    """get_research_result is not metered - report_usage should not be called."""
    event = {
        'body': json.dumps({
            'operation': 'get_research_result',
            'job_id': 'test-job',
        }),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    with patch.object(llm_module, 'LLMService') as MockSvc:
        MockSvc.return_value.get_research_result.return_value = {'status': 'pending'}
        response = llm_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 200
    mock_services['quota'].report_usage.assert_not_called()


def test_usage_report_failure_still_succeeds(lambda_context, llm_module, mock_services):
    """When quota reporting fails, operations should still succeed (graceful degradation)."""
    mock_services['quota'].report_usage.side_effect = Exception('DDB unavailable')
    event = {
        'body': json.dumps({
            'operation': 'generate_message',
            'conversationTopic': 'AI trends',
            'connectionProfile': {'firstName': 'A', 'lastName': 'B', 'position': 'X', 'company': 'Y'},
        }),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    with patch.object(llm_module, 'LLMService') as MockSvc:
        MockSvc.return_value.generate_message.return_value = {'message': 'Hello'}
        response = llm_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 200
