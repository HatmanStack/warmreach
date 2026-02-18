"""LLM Endpoint Lambda - Routes AI operations to LLMService."""

import json
import logging
import os

import boto3
from errors.exceptions import ServiceError, ValidationError
from openai import OpenAI
from services.llm_service import LLMService
from shared_services.monetization import (
    FeatureFlagService,
    QuotaExceededError,
    QuotaService,
    ensure_tier_exists,
)

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Clients
openai_client = OpenAI(api_key=os.environ.get('OPENAI_API_KEY'), timeout=60)
bedrock_client = boto3.client('bedrock-runtime')
table_name = os.environ.get('DYNAMODB_TABLE_NAME')
table = boto3.resource('dynamodb').Table(table_name) if table_name else None

# CORS configuration
ALLOWED_ORIGINS_ENV = os.environ.get('ALLOWED_ORIGINS', 'http://localhost:5173')
ALLOWED_ORIGINS = [o.strip() for o in ALLOWED_ORIGINS_ENV.split(',') if o.strip()]

BASE_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
}
OPS = {'generate_ideas', 'research_selected_ideas', 'get_research_result', 'synthesize_research', 'generate_message'}
METERED_OPS = {'generate_ideas', 'research_selected_ideas', 'synthesize_research', 'generate_message'}
DEEP_RESEARCH_OPS = {'research_selected_ideas', 'synthesize_research'}

_quota_service = QuotaService(table) if table else None
_feature_flag_service = FeatureFlagService(table) if table else None


def _get_origin_from_event(event):
    headers = event.get('headers') or {}
    return headers.get('origin') or headers.get('Origin')


def _cors_headers(event):
    origin = _get_origin_from_event(event)
    allow_origin = origin if origin in ALLOWED_ORIGINS else (ALLOWED_ORIGINS[0] if ALLOWED_ORIGINS else '*')
    return {**BASE_HEADERS, 'Access-Control-Allow-Origin': allow_origin, 'Vary': 'Origin'}


def _resp(code, body, event=None):
    headers = (
        _cors_headers(event)
        if event
        else {
            **BASE_HEADERS,
            'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] if ALLOWED_ORIGINS else '*',
            'Vary': 'Origin',
        }
    )
    return {'statusCode': code, 'headers': headers, 'body': json.dumps(body)}


def _get_user_id(event):
    # HTTP API v2 JWT authorizer path
    sub = event.get('requestContext', {}).get('authorizer', {}).get('jwt', {}).get('claims', {}).get('sub')
    if sub:
        return sub
    # Fallback for REST API path
    sub = event.get('requestContext', {}).get('authorizer', {}).get('claims', {}).get('sub')
    if sub:
        return sub
    return None


def lambda_handler(event, _context):
    """Route LLM operations to LLMService."""
    try:
        from shared_services.observability import setup_correlation_context

        setup_correlation_context(event, _context)
        method = event.get('requestContext', {}).get('http', {}).get('method', '')
        if method == 'OPTIONS' or event.get('httpMethod') == 'OPTIONS':
            return _resp(200, {'ok': True}, event)

        body = json.loads(event.get('body', '{}')) if isinstance(event.get('body'), str) else event.get('body') or {}
        user_id = _get_user_id(event)
        if not user_id:
            return _resp(401, {'error': 'Unauthorized'}, event)

        op = body.get('operation')
        if not op or op not in OPS:
            return _resp(400, {'error': 'Invalid operation'}, event)

        # Auto-provision tier on first call (non-blocking)
        if table:
            try:
                ensure_tier_exists(table, user_id)
            except Exception:
                logger.debug('Tier auto-provision failed, continuing')

        # Feature gate: deep research ops require feature flag
        if op in DEEP_RESEARCH_OPS and _feature_flag_service:
            try:
                flags = _feature_flag_service.get_feature_flags(user_id)
                if not flags.get('features', {}).get('deep_research', False):
                    return _resp(
                        403,
                        {
                            'error': 'Feature not available on current plan',
                            'code': 'FEATURE_GATED',
                            'feature': 'deep_research',
                        },
                        event,
                    )
            except Exception:
                logger.warning('Feature flag check failed, allowing request')
                pass

        svc = LLMService(openai_client=openai_client, bedrock_client=bedrock_client, table=table)

        if op == 'generate_ideas':
            if not body.get('job_id'):
                return _resp(400, {'error': 'job_id required'}, event)
            result = svc.generate_ideas(body.get('user_profile'), body.get('prompt', ''), body['job_id'], user_id)

        elif op == 'research_selected_ideas':
            result = svc.research_selected_ideas(body.get('user_profile', {}), body.get('selected_ideas', []), user_id)

        elif op == 'get_research_result':
            if not body.get('job_id'):
                return _resp(400, {'error': 'job_id required'}, event)
            result = svc.get_research_result(user_id, body['job_id'], body.get('kind'))

        elif op == 'synthesize_research':
            if not body.get('job_id'):
                return _resp(400, {'error': 'job_id required'}, event)
            result = svc.synthesize_research(
                body.get('research_content'),
                body.get('existing_content'),
                body.get('selected_ideas', []),
                body.get('user_profile', {}),
                body['job_id'],
                user_id,
            )

        elif op == 'generate_message':
            if not body.get('conversationTopic'):
                return _resp(400, {'error': 'conversationTopic required'}, event)
            if not body.get('connectionProfile'):
                return _resp(400, {'error': 'connectionProfile required'}, event)
            result = svc.generate_message(
                connection_profile=body['connectionProfile'],
                conversation_topic=body['conversationTopic'],
                user_profile=body.get('userProfile'),
                message_history=body.get('messageHistory'),
                connection_id=body.get('connectionId'),
            )

        else:
            return _resp(400, {'error': f'Unsupported: {op}'}, event)

        # Report usage for metered operations after success.
        # Note: if report_usage raises QuotaExceededError the LLM op already ran.
        # This is intentional — the 429 signals the client to stop further requests
        # while still delivering the result of the current (already-completed) op.
        if op in METERED_OPS and _quota_service:
            try:
                _quota_service.report_usage(user_id, op, count=1)
            except QuotaExceededError:
                raise
            except Exception:
                logger.warning(f'Usage reporting failed for {op}, allowing request')

        return _resp(200, result, event)

    except QuotaExceededError as e:
        logger.warning(f'Quota exceeded: {e.message}', extra={'code': e.code, 'details': e.details})
        return _resp(
            429,
            {'error': e.message, 'code': e.code, 'operation': e.details.get('operation'), 'details': e.details},
            event,
        )
    except ValidationError as e:
        logger.warning(f'Validation error: {e.message}', extra={'details': e.details})
        return _resp(400, {'error': e.message, 'code': e.code, 'details': e.details}, event)
    except ServiceError as e:
        logger.error(f'Service error: {e.message}', extra={'code': e.code, 'details': e.details})
        return _resp(500, {'error': e.message, 'code': e.code}, event)
    except Exception as e:
        logger.exception(f'Unexpected error in LLM handler: {e}')
        return _resp(500, {'error': 'Internal server error'}, event)
