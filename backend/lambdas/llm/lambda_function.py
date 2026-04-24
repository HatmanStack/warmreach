"""LLM Endpoint Lambda - Routes AI operations to LLMService."""

import json
import logging
import os

import boto3
from errors.exceptions import ServiceError, ValidationError
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

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Clients
OPENAI_TIMEOUT = int(os.environ.get('OPENAI_TIMEOUT', '60'))  # Optional: defaults to 60s
openai_client = OpenAI(api_key=os.environ.get('OPENAI_API_KEY'), timeout=OPENAI_TIMEOUT)
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

# Module-level LLMService for warm container reuse
_llm_service = LLMService(openai_client=openai_client, bedrock_client=_get_bedrock_client(), table=table)

OPS = {
    'generate_ideas',
    'research_selected_ideas',
    'get_research_result',
    'synthesize_research',
    'generate_message',
    'analyze_message_patterns',
    'analyze_tone',
}
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
    if not body.get('conversationTopic'):
        return api_response(400, {'error': 'conversationTopic required'}, None)
    if not body.get('connectionProfile'):
        return api_response(400, {'error': 'connectionProfile required'}, None)
    return svc.generate_message(
        connection_profile=body['connectionProfile'],
        conversation_topic=body['conversationTopic'],
        user_profile=body.get('userProfile'),
        message_history=body.get('messageHistory'),
        connection_id=body.get('connectionId'),
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

        # Auto-provision tier on first call (non-blocking)
        if table:
            from botocore.exceptions import ClientError

            try:
                ensure_tier_exists(table, user_id)
            except ClientError as e:
                logger.error('Tier auto-provision failed due to DynamoDB error: %s', e)
            except Exception as e:
                logger.error('Tier auto-provision failed: %s', e)

        # Feature gate checks
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
                    logger.error('Feature flag check failed for %s, denying request', feature_to_check)
                    return api_response(503, {'error': 'Feature availability check failed'}, event)

        # Pre-call quota reservation (ADR-B). In the community edition the
        # reservation and release are no-ops, but we keep the plumbing so the
        # handler contract stays identical between editions.
        reserved = False
        if op in METERED_OPS and _quota_service:
            try:
                _quota_service.reserve_usage(user_id, op, count=1)
                reserved = True
            except QuotaExceededError:
                raise
            except Exception:
                logger.warning('reserve_usage failed for %s, allowing request', op)

        # Dispatch via routing table
        handler = HANDLERS[op]
        try:
            result = handler(body, user_id, _llm_service)
        except Exception:
            if reserved and _quota_service:
                try:
                    _quota_service.release_usage(user_id, op, count=1)
                except Exception:
                    logger.exception('release_usage failed for %s', op)
            raise

        # If the handler returned an api_response (e.g. 400 validation error), pass it through
        if isinstance(result, dict) and 'statusCode' in result:
            if reserved and _quota_service and result.get('statusCode', 200) >= 400:
                try:
                    _quota_service.release_usage(user_id, op, count=1)
                except Exception:
                    logger.exception('release_usage failed for %s after handler error response', op)
            return result

        # Emit activity events for successful operations
        if table:
            if op == 'generate_message':
                write_activity(
                    table, user_id, 'ai_message_generated', metadata={'connectionId': body.get('connectionId')}
                )
            elif op == 'analyze_tone':
                write_activity(table, user_id, 'ai_tone_analysis')
            elif op in DEEP_RESEARCH_OPS:
                write_activity(table, user_id, 'ai_deep_research')

        # Usage was already reserved pre-call; nothing to report on success.
        return api_response(200, result, event)

    except QuotaExceededError as e:
        logger.warning('Quota exceeded: %s', e.message, extra={'code': e.code, 'details': e.details})
        return api_response(
            429,
            {'error': e.message, 'code': e.code, 'operation': e.details.get('operation'), 'details': e.details},
            event,
        )
    except ValidationError as e:
        logger.warning('Validation error: %s', e.message, extra={'details': e.details})
        return api_response(400, {'error': e.message, 'code': e.code, 'details': e.details}, event)
    except ServiceError as e:
        logger.error('Service error: %s', e.message, extra={'code': e.code, 'details': e.details})
        return api_response(500, {'error': e.message, 'code': e.code}, event)
    except Exception as e:
        logger.exception('Unexpected error in LLM handler: %s', e)
        return api_response(500, {'error': 'Internal server error'}, event)
