"""LLM Endpoint Lambda - Routes AI operations to LLMService."""

import json
import logging
import os
import time

import boto3
from openai import OpenAI
from services.llm_service import LLMService
from shared_services.activity_writer import write_activity
from shared_services.monetization import (
    FeatureFlagService,
    QuotaExceededError,
    QuotaService,
    ensure_tier_exists,
)
from shared_services.observability import setup_correlation_context
from shared_services.request_utils import api_response, extract_user_id
from shared_services.ssm_cache import SSMCachedSecret

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# ---------------------------------------------------------------------------
# SSM-backed OpenAI API key with TTL cache (ADR-3)
# ---------------------------------------------------------------------------
_openai_secret = SSMCachedSecret(os.environ.get('OPENAI_API_KEY_ARN', ''))


def _get_openai_client():
    """Return an OpenAI client using the SSM-fetched API key."""
    return OpenAI(api_key=_openai_secret.get_value(), timeout=OPENAI_TIMEOUT)


# Clients
OPENAI_TIMEOUT = int(os.environ.get('OPENAI_TIMEOUT', '60'))  # Optional: defaults to 60s
_bedrock_client = None


def _get_bedrock_client():
    global _bedrock_client
    if _bedrock_client is None:
        _bedrock_client = boto3.client('bedrock-runtime')
    return _bedrock_client
# Optional: LLM Lambda can serve AI-only operations (generate, research) without DynamoDB.
# Quota enforcement and usage tracking require DynamoDB but are skipped when table is None.
table_name = os.environ.get('DYNAMODB_TABLE_NAME')
table = boto3.resource('dynamodb').Table(table_name) if table_name else None

# LLMService initialized lazily on first invocation with TTL refresh
_llm_service = None
_llm_service_created_at: float = 0
_LLM_SERVICE_TTL = 300  # 5 minutes


def _get_llm_service():
    """Return cached LLMService, recreating after TTL to pick up rotated keys."""
    global _llm_service, _llm_service_created_at
    now = time.time()
    if _llm_service is None or (now - _llm_service_created_at) > _LLM_SERVICE_TTL:
        openai_client = _get_openai_client()
        _llm_service = LLMService(openai_client=openai_client, bedrock_client=_get_bedrock_client(), table=table)
        _llm_service_created_at = now
    return _llm_service

OPS = {
    'generate_ideas',
    'research_selected_ideas',
    'get_research_result',
    'synthesize_research',
    'generate_message',
    'analyze_message_patterns',
    'analyze_tone',
}
# Maximum total character count for request body fields that flow into LLM prompts.
# ~50k chars is roughly 12.5k tokens; larger inputs waste tokens and risk timeouts.
MAX_INPUT_SIZE = 50_000

METERED_OPS = {
    'generate_ideas',
    'research_selected_ideas',
    'synthesize_research',
    'generate_message',
    'analyze_message_patterns',
    'analyze_tone',
}
DEEP_RESEARCH_OPS = {'research_selected_ideas', 'synthesize_research'}
MESSAGE_INTEL_OPS = {'analyze_message_patterns'}
TONE_ANALYSIS_OPS = {'analyze_tone'}

_quota_service = QuotaService(table) if table else None
_feature_flag_service = FeatureFlagService(table) if table else None


# ---------------------------------------------------------------------------
# Operation handlers — each takes (body, user_id, svc) and returns a result dict
# ---------------------------------------------------------------------------


def _handle_generate_ideas(body, user_id, svc):
    if not body.get('job_id'):
        return api_response(400, {'error': 'job_id required'}, None)
    return svc.generate_ideas(body.get('user_profile'), body.get('prompt', ''), body['job_id'], user_id)


def _handle_research_selected_ideas(body, user_id, svc):
    return svc.research_selected_ideas(body.get('user_profile', {}), body.get('selected_ideas', []), user_id)


def _handle_get_research_result(body, user_id, svc):
    if not body.get('job_id'):
        return api_response(400, {'error': 'job_id required'}, None)
    return svc.get_research_result(user_id, body['job_id'], body.get('kind'))


def _handle_synthesize_research(body, user_id, svc):
    if not body.get('job_id'):
        return api_response(400, {'error': 'job_id required'}, None)
    return svc.synthesize_research(
        body.get('research_content'),
        body.get('existing_content'),
        body.get('selected_ideas', []),
        body.get('user_profile', {}),
        body['job_id'],
        user_id,
    )


def _handle_generate_message(body, user_id, svc):
    mode = body.get('mode', 'standard')
    # Icebreaker mode does not require conversationTopic
    if mode != 'icebreaker' and not body.get('conversationTopic'):
        return api_response(400, {'error': 'conversationTopic required'}, None)
    if not body.get('connectionProfile'):
        return api_response(400, {'error': 'connectionProfile required'}, None)
    return svc.generate_message(
        connection_profile=body['connectionProfile'],
        conversation_topic=body.get('conversationTopic', ''),
        user_profile=body.get('userProfile'),
        message_history=body.get('messageHistory'),
        connection_id=body.get('connectionId'),
        mode=mode,
        connection_notes=body.get('connectionNotes'),
    )


def _handle_analyze_message_patterns(body, user_id, svc):
    return svc.analyze_message_patterns(
        stats=body.get('stats', {}),
        sample_messages=body.get('sampleMessages', []),
    )


def _handle_analyze_tone(body, user_id, svc):
    draft_text = body.get('draftText', '')
    if not draft_text or not draft_text.strip():
        return api_response(400, {'error': 'draftText is required'}, None)
    return svc.analyze_tone(
        draft_text=draft_text,
        recipient_name=body.get('recipientName', ''),
        recipient_position=body.get('recipientPosition', ''),
        relationship_status=body.get('relationshipStatus', ''),
    )


# ---------------------------------------------------------------------------
# Routing table
# ---------------------------------------------------------------------------

HANDLERS = {
    'generate_ideas': _handle_generate_ideas,
    'research_selected_ideas': _handle_research_selected_ideas,
    'get_research_result': _handle_get_research_result,
    'synthesize_research': _handle_synthesize_research,
    'generate_message': _handle_generate_message,
    'analyze_message_patterns': _handle_analyze_message_patterns,
    'analyze_tone': _handle_analyze_tone,
}


def lambda_handler(event, _context):
    """Route LLM operations to LLMService."""
    try:
        setup_correlation_context(event, _context)
        method = event.get('requestContext', {}).get('http', {}).get('method', '')
        if method == 'OPTIONS' or event.get('httpMethod') == 'OPTIONS':
            return api_response(204, {}, event)

        body = json.loads(event.get('body', '{}')) if isinstance(event.get('body'), str) else event.get('body') or {}
        user_id = extract_user_id(event)
        if not user_id:
            return api_response(401, {'error': 'Unauthorized'}, event)

        op = body.get('operation')
        if not op or op not in OPS:
            return api_response(400, {'error': 'Invalid operation'}, event)

        # Validate total input size to prevent token waste and timeouts
        body_str = event.get('body', '{}') if isinstance(event.get('body'), str) else json.dumps(body)
        if len(body_str) > MAX_INPUT_SIZE:
            logger.warning('Input size %d exceeds limit %d for op=%s', len(body_str), MAX_INPUT_SIZE, op)
            return api_response(
                400,
                {
                    'error': f'Input size exceeds maximum allowed ({MAX_INPUT_SIZE} characters)',
                    'code': 'INPUT_TOO_LARGE',
                },
                event,
            )

        # Auto-provision tier on first call (non-blocking)
        if table:
            from botocore.exceptions import ClientError

            try:
                ensure_tier_exists(table, user_id)
            except ClientError:
                logger.exception('Tier auto-provision failed due to DynamoDB error')
            except Exception:
                logger.exception('Tier auto-provision failed')

        # Feature gate checks (before lazy-init to avoid SSM calls for gated ops)
        if _feature_flag_service:
            feature_to_check = None
            if op in DEEP_RESEARCH_OPS:
                feature_to_check = 'deep_research'
            elif op in TONE_ANALYSIS_OPS:
                feature_to_check = 'tone_analysis'
            elif op in MESSAGE_INTEL_OPS:
                feature_to_check = 'message_intelligence'

            if feature_to_check:
                try:
                    flags = _feature_flag_service.get_feature_flags(user_id)
                    if not flags.get('features', {}).get(feature_to_check, False):
                        return api_response(
                            403,
                            {
                                'error': 'Feature not available on current plan',
                                'code': 'FEATURE_GATED',
                                'feature': feature_to_check,
                            },
                            event,
                        )
                except Exception:
                    logger.exception('Feature flag check failed for %s, denying request', feature_to_check)
                    return api_response(503, {'error': 'Feature availability check failed'}, event)

        # Lazy-init LLMService with TTL refresh for key rotation
        svc = _get_llm_service()

        # Dispatch via routing table
        handler = HANDLERS[op]
        result = handler(body, user_id, svc)

        # If the handler returned an api_response (e.g. 400 validation error), pass it through
        if isinstance(result, dict) and 'statusCode' in result:
            return result

        # Emit activity events for successful operations
        if table:
            if op == 'generate_message':
                if body.get('mode') == 'icebreaker':
                    write_activity(
                        table, user_id, 'icebreaker_generated', metadata={'connectionId': body.get('connectionId')}
                    )
                else:
                    write_activity(
                        table, user_id, 'ai_message_generated', metadata={'connectionId': body.get('connectionId')}
                    )
            elif op == 'analyze_tone':
                write_activity(table, user_id, 'ai_tone_analysis')
            elif op in DEEP_RESEARCH_OPS:
                write_activity(table, user_id, 'ai_deep_research')

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
                logger.exception('Usage reporting failed for %s, allowing request', op)

        return api_response(200, result, event)

    except QuotaExceededError as e:
        logger.warning(f'Quota exceeded: {e.message}', extra={'code': e.code, 'details': e.details})
        return api_response(
            429,
            {'error': e.message, 'code': e.code, 'operation': e.details.get('operation'), 'details': e.details},
            event,
        )
    except Exception as e:
        logger.exception('Unexpected error in LLM handler: %s', e)
        return api_response(500, {'error': 'Internal server error'}, event)
