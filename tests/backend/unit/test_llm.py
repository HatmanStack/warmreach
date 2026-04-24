"""Handler-level tests for LLM Lambda function (community edition).

Pro-only handler tests (`summarize_evidence`, feedback operations, metered
quota paths) are kept in the pro source copy and are not ported here because
the corresponding handlers do not exist in the community LLM Lambda.
"""
import json
from unittest.mock import MagicMock, patch

import pytest

from conftest import load_lambda_module


@pytest.fixture
def llm_module():
    """Load the LLM Lambda module within a mock AWS context."""
    from moto import mock_aws
    with mock_aws():
        return load_lambda_module('llm')


@pytest.fixture
def mock_services(llm_module):
    """Replace module-level quota, feature flag, and LLM services with mocks."""
    mock_quota = MagicMock()
    mock_quota.report_usage.return_value = None
    mock_ff = MagicMock()
    mock_ff.get_feature_flags.return_value = {
        'tier': 'paid',
        'features': {
            'deep_research': True,
            'ai_messaging': True,
            'tone_analysis': True,
            'message_intelligence': True,
        },
        'quotas': {},
        'rateLimits': {},
    }

    orig_quota = llm_module._quota_service
    orig_ff = llm_module._feature_flag_service
    orig_llm = llm_module._llm_service
    llm_module._quota_service = mock_quota
    llm_module._feature_flag_service = mock_ff
    # Set a stub LLM service so lazy-init doesn't try to fetch SSM secrets.
    # Tests that need specific LLM behavior override _llm_service themselves.
    if llm_module._llm_service is None:
        llm_module._llm_service = MagicMock()
    yield {'quota': mock_quota, 'feature_flags': mock_ff}
    llm_module._quota_service = orig_quota
    llm_module._feature_flag_service = orig_ff
    llm_module._llm_service = orig_llm


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


def test_options_preflight_returns_204(lambda_context, llm_module):
    """OPTIONS preflight returns 204 No Content."""
    event = {
        'requestContext': {
            'http': {'method': 'OPTIONS'},
        },
    }
    response = llm_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 204


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
    mock_svc = MagicMock()
    mock_svc.generate_message.return_value = {'message': 'Hello'}
    orig_svc = llm_module._llm_service
    llm_module._llm_service = mock_svc
    try:
        response = llm_module.lambda_handler(event, lambda_context)
    finally:
        llm_module._llm_service = orig_svc
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
    mock_svc = MagicMock()
    mock_svc.get_research_result.return_value = {'status': 'pending'}
    orig_svc = llm_module._llm_service
    llm_module._llm_service = mock_svc
    try:
        response = llm_module.lambda_handler(event, lambda_context)
    finally:
        llm_module._llm_service = orig_svc
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
    mock_svc = MagicMock()
    mock_svc.generate_message.return_value = {'message': 'Hello'}
    orig_svc = llm_module._llm_service
    llm_module._llm_service = mock_svc
    try:
        response = llm_module.lambda_handler(event, lambda_context)
    finally:
        llm_module._llm_service = orig_svc
    assert response['statusCode'] == 200


# ---- analyze_message_patterns tests ----


def test_analyze_message_patterns_routes_correctly(lambda_context, llm_module, mock_services):
    """analyze_message_patterns calls LLMService with stats and sample messages."""
    mock_services['feature_flags'].get_feature_flags.return_value = {
        'tier': 'paid',
        'features': {'message_intelligence': True, 'deep_research': True, 'ai_messaging': True},
        'quotas': {},
        'rateLimits': {},
    }
    event = {
        'body': json.dumps({
            'operation': 'analyze_message_patterns',
            'stats': {'totalOutbound': 10, 'totalInbound': 5, 'responseRate': 0.5},
            'sampleMessages': [{'content': 'hello', 'got_response': True}],
        }),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    mock_svc = MagicMock()
    mock_result = {'insights': ['Insight 1', 'Insight 2'], 'analyzedAt': '2026-01-01T00:00:00'}
    mock_svc.analyze_message_patterns.return_value = mock_result
    orig_svc = llm_module._llm_service
    llm_module._llm_service = mock_svc
    try:
        response = llm_module.lambda_handler(event, lambda_context)
    finally:
        llm_module._llm_service = orig_svc
    assert response['statusCode'] == 200
    body = json.loads(response['body'])
    assert body['insights'] == ['Insight 1', 'Insight 2']
    mock_svc.analyze_message_patterns.assert_called_once()


def test_analyze_message_patterns_feature_gated(lambda_context, llm_module, mock_services):
    """analyze_message_patterns returns 403 when message_intelligence is disabled."""
    mock_services['feature_flags'].get_feature_flags.return_value = {
        'tier': 'free',
        'features': {'message_intelligence': False, 'deep_research': True},
        'quotas': {},
        'rateLimits': {},
    }
    event = {
        'body': json.dumps({
            'operation': 'analyze_message_patterns',
            'stats': {},
            'sampleMessages': [],
        }),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    response = llm_module.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 403
    body = json.loads(response['body'])
    assert body['code'] == 'FEATURE_GATED'
    assert body['feature'] == 'message_intelligence'


class TestConfigurableOpenAITimeout:
    """Tests for configurable OpenAI timeout via OPENAI_TIMEOUT env var."""

    def test_default_timeout_is_60(self):
        """Default timeout should be 60 when OPENAI_TIMEOUT is not set."""
        import os
        # Ensure OPENAI_TIMEOUT is not set
        env_val = os.environ.pop('OPENAI_TIMEOUT', None)
        try:
            from moto import mock_aws
            with mock_aws():
                module = load_lambda_module('llm')
                assert module.OPENAI_TIMEOUT == 60
        finally:
            if env_val is not None:
                os.environ['OPENAI_TIMEOUT'] = env_val

    def test_custom_timeout_from_env(self):
        """Should use custom timeout when OPENAI_TIMEOUT is set."""
        import os
        os.environ['OPENAI_TIMEOUT'] = '120'
        try:
            from moto import mock_aws
            with mock_aws():
                module = load_lambda_module('llm')
                assert module.OPENAI_TIMEOUT == 120
        finally:
            del os.environ['OPENAI_TIMEOUT']


def test_analyze_message_patterns_metered(lambda_context, llm_module, mock_services):
    """analyze_message_patterns calls report_usage (it's a metered op)."""
    mock_services['feature_flags'].get_feature_flags.return_value = {
        'tier': 'paid',
        'features': {'message_intelligence': True, 'deep_research': True, 'ai_messaging': True},
        'quotas': {},
        'rateLimits': {},
    }
    event = {
        'body': json.dumps({
            'operation': 'analyze_message_patterns',
            'stats': {'totalOutbound': 5},
            'sampleMessages': [],
        }),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    mock_svc = MagicMock()
    mock_svc.analyze_message_patterns.return_value = {'insights': [], 'analyzedAt': '2026-01-01'}
    orig_svc = llm_module._llm_service
    llm_module._llm_service = mock_svc
    try:
        response = llm_module.lambda_handler(event, lambda_context)
    finally:
        llm_module._llm_service = orig_svc
    assert response['statusCode'] == 200
    mock_services['quota'].report_usage.assert_called_once_with('test-user', 'analyze_message_patterns', count=1)


# ---- Activity writer instrumentation tests ----


def test_generate_message_emits_activity(lambda_context, llm_module, mock_services):
    """generate_message emits ai_message_generated activity."""
    event = {
        'body': json.dumps({
            'operation': 'generate_message',
            'conversationTopic': 'AI trends',
            'connectionProfile': {'firstName': 'A', 'lastName': 'B', 'position': 'X', 'company': 'Y'},
            'connectionId': 'conn-123',
        }),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    mock_svc = MagicMock()
    mock_svc.generate_message.return_value = {'message': 'Hello'}
    orig_svc = llm_module._llm_service
    llm_module._llm_service = mock_svc
    try:
        with patch.object(llm_module, 'write_activity') as mock_wa:
            response = llm_module.lambda_handler(event, lambda_context)
    finally:
        llm_module._llm_service = orig_svc
    assert response['statusCode'] == 200
    mock_wa.assert_called_once()
    args = mock_wa.call_args[0]
    kwargs = mock_wa.call_args[1]
    assert args[2] == 'ai_message_generated'
    assert kwargs['metadata']['connectionId'] == 'conn-123'


def test_analyze_tone_emits_activity(lambda_context, llm_module, mock_services):
    """analyze_tone emits ai_tone_analysis activity."""
    mock_services['feature_flags'].get_feature_flags.return_value = {
        'tier': 'paid',
        'features': {'tone_analysis': True},
        'quotas': {},
        'rateLimits': {},
    }
    event = {
        'body': json.dumps({
            'operation': 'analyze_tone',
            'draftText': 'This is a test message.',
        }),
        'requestContext': {
            'authorizer': {'claims': {'sub': 'test-user'}}
        },
    }
    mock_svc = MagicMock()
    mock_svc.analyze_tone.return_value = {'tone': 'professional'}
    orig_svc = llm_module._llm_service
    llm_module._llm_service = mock_svc
    try:
        with patch.object(llm_module, 'write_activity') as mock_wa:
            response = llm_module.lambda_handler(event, lambda_context)
    finally:
        llm_module._llm_service = orig_svc
    assert response['statusCode'] == 200
    mock_wa.assert_called_once()
    args = mock_wa.call_args[0]
    assert args[2] == 'ai_tone_analysis'



def test_standard_mode_unchanged(lambda_context, llm_module, mock_services):
    """Standard mode still works as before."""
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
    mock_svc = MagicMock()
    mock_svc.generate_message.return_value = {'generatedMessage': 'Hello!', 'confidence': 0.85}
    orig_svc = llm_module._llm_service
    llm_module._llm_service = mock_svc
    try:
        with patch.object(llm_module, 'write_activity') as mock_wa:
            response = llm_module.lambda_handler(event, lambda_context)
    finally:
        llm_module._llm_service = orig_svc
    assert response['statusCode'] == 200
    body = json.loads(response['body'])
    assert body['generatedMessage'] == 'Hello!'
    mock_wa.assert_called_once()
    args = mock_wa.call_args[0]
    assert args[2] == 'ai_message_generated'
