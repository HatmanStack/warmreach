"""LinkedIn Edge Management Lambda - Routes edge and RAGStack operations."""

import json
import logging
import os

import boto3
from errors.exceptions import AuthorizationError, ExternalServiceError, NotFoundError, ServiceError, ValidationError
from services.edge_service import EdgeService
from shared_services.monetization import QuotaService, ensure_tier_exists

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Configuration and clients
table = boto3.resource('dynamodb').Table(os.environ.get('DYNAMODB_TABLE_NAME', 'warmreach'))
RAGSTACK_GRAPHQL_ENDPOINT = os.environ.get('RAGSTACK_GRAPHQL_ENDPOINT', '')
RAGSTACK_API_KEY = os.environ.get('RAGSTACK_API_KEY', '')

# Module-level clients for warm container reuse
_ragstack_client = None
_ingestion_service = None
_quota_service = QuotaService(table) if table else None

if RAGSTACK_GRAPHQL_ENDPOINT and RAGSTACK_API_KEY:
    from shared_services.ingestion_service import IngestionService
    from shared_services.ragstack_client import RAGStackClient

    _ragstack_client = RAGStackClient(RAGSTACK_GRAPHQL_ENDPOINT, RAGSTACK_API_KEY)
    _ingestion_service = IngestionService(_ragstack_client)

# CORS configuration
ALLOWED_ORIGINS_ENV = os.environ.get('ALLOWED_ORIGINS', 'http://localhost:5173')
ALLOWED_ORIGINS = [o.strip() for o in ALLOWED_ORIGINS_ENV.split(',') if o.strip()]

BASE_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
}


def _get_origin_from_event(event):
    headers = event.get('headers') or {}
    return headers.get('origin') or headers.get('Origin')


def _cors_headers(event):
    origin = _get_origin_from_event(event)
    allow_origin = origin if origin in ALLOWED_ORIGINS else (ALLOWED_ORIGINS[0] if ALLOWED_ORIGINS else '*')
    return {**BASE_HEADERS, 'Access-Control-Allow-Origin': allow_origin, 'Vary': 'Origin'}


def _sanitize_request_context(request_context):
    """Remove sensitive fields from requestContext before logging."""
    if not request_context:
        return {}
    sanitized = {}
    sensitive_keys = {'authorizer', 'authorization'}
    for key, value in request_context.items():
        if key.lower() in sensitive_keys:
            sanitized[key] = '[REDACTED]'
        elif isinstance(value, dict):
            sanitized[key] = {
                k: '[REDACTED]'
                if any(s in k.lower() for s in ('token', 'authorization', 'claim', 'secret', 'credential'))
                else v
                for k, v in value.items()
            }
        else:
            sanitized[key] = value
    return sanitized


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
    if os.environ.get('DEV_MODE', '').lower() == 'true':
        return 'test-user-development'
    return None


def _report_telemetry(user_id: str, operation: str, count: int = 1):
    """Fire-and-forget usage telemetry. Never blocks the response."""
    if not _quota_service or not user_id:
        return
    try:
        ensure_tier_exists(table, user_id)
        _quota_service.report_usage(user_id, operation, count=count)
    except Exception as e:
        logger.debug(f'Telemetry report failed for {operation}: {e}')


def _handle_ragstack(body, user_id, svc, event=None):
    """Handle /ragstack route - thin dispatcher to EdgeService RAGStack methods."""
    if not svc.ragstack_client:
        return _resp(503, {'error': 'RAGStack not configured'}, event)

    operation = body.get('operation')

    if operation == 'search':
        query = body.get('query', '')
        if not query:
            return _resp(400, {'error': 'query is required'}, event)
        try:
            max_results = min(int(body.get('maxResults', 100)), 200)
        except (TypeError, ValueError):
            return _resp(400, {'error': 'maxResults must be a number'}, event)
        result = svc.ragstack_search(query, max_results)
        _report_telemetry(user_id, 'ragstack_search')
        return _resp(200, result, event)

    elif operation == 'ingest':
        profile_id = body.get('profileId')
        markdown_content = body.get('markdownContent')
        metadata = body.get('metadata') or {}
        if not isinstance(metadata, dict):
            return _resp(400, {'error': 'metadata must be an object'}, event)
        if not profile_id:
            return _resp(400, {'error': 'profileId is required'}, event)
        if not markdown_content:
            return _resp(400, {'error': 'markdownContent is required'}, event)
        result = svc.ragstack_ingest(profile_id, markdown_content, metadata, user_id)
        _report_telemetry(user_id, 'ragstack_ingest')
        return _resp(200, result, event)

    elif operation == 'status':
        document_id = body.get('documentId')
        if not document_id:
            return _resp(400, {'error': 'documentId is required'}, event)
        result = svc.ragstack_status(document_id)
        return _resp(200, result, event)

    elif operation == 'scrape_start':
        profile_id = body.get('profileId')
        cookies = body.get('cookies')
        if not profile_id:
            return _resp(400, {'error': 'profileId is required'}, event)
        if not cookies:
            return _resp(400, {'error': 'cookies is required'}, event)
        scrape_config = body.get('scrapeConfig', {})
        if not isinstance(scrape_config, dict):
            return _resp(400, {'error': 'scrapeConfig must be a JSON object'}, event)
        result = svc.ragstack_scrape_start(profile_id, cookies, scrape_config)
        _report_telemetry(user_id, 'ragstack_scrape')
        return _resp(200, result, event)

    elif operation == 'scrape_status':
        job_id = body.get('jobId')
        if not job_id:
            return _resp(400, {'error': 'jobId is required'}, event)
        result = svc.ragstack_scrape_status(job_id)
        return _resp(200, result, event)

    else:
        return _resp(400, {'error': f'Unsupported ragstack operation: {operation}'}, event)


def lambda_handler(event, context):
    """Route edge operations to EdgeService."""
    from shared_services.observability import setup_correlation_context

    setup_correlation_context(event, context)

    # Debug logging
    logger.info(f'Event keys: {list(event.keys())}')
    logger.info(
        f'Request context: {json.dumps(_sanitize_request_context(event.get("requestContext", {})), default=str)}'
    )

    # Handle CORS preflight
    if event.get('requestContext', {}).get('http', {}).get('method') == 'OPTIONS':
        return _resp(200, {'message': 'OK'}, event)

    try:
        body = (
            json.loads(event.get('body', '{}'))
            if isinstance(event.get('body'), str)
            else event.get('body') or event or {}
        )
        user_id = _get_user_id(event)
        logger.info(f'Extracted user_id: {user_id}')
        if not user_id:
            return _resp(401, {'error': 'Unauthorized'}, event)

        # Determine route
        raw_path = event.get('rawPath', '') or event.get('path', '')

        op, pid, updates = body.get('operation'), body.get('profileId'), body.get('updates', {})
        svc = EdgeService(
            table=table,
            ragstack_endpoint=RAGSTACK_GRAPHQL_ENDPOINT,
            ragstack_api_key=RAGSTACK_API_KEY,
            ragstack_client=_ragstack_client,
            ingestion_service=_ingestion_service,
        )

        if '/ragstack' in raw_path:
            return _handle_ragstack(body, user_id, svc, event)

        if op == 'get_connections_by_status':
            r = svc.get_connections_by_status(user_id, updates.get('status'))
            return _resp(200, {'connections': r.get('connections', []), 'count': r.get('count', 0)}, event)
        if op == 'upsert_status':
            if not pid:
                return _resp(400, {'error': 'profileId required'}, event)
            return _resp(
                200,
                {
                    'result': svc.upsert_status(
                        user_id, pid, updates.get('status', 'pending'), updates.get('addedAt'), updates.get('messages')
                    )
                },
                event,
            )
        if op == 'add_message':
            if not pid:
                return _resp(400, {'error': 'profileId required'}, event)
            return _resp(
                200,
                {
                    'result': svc.add_message(
                        user_id, pid, updates.get('message', ''), updates.get('messageType', 'outbound')
                    )
                },
                event,
            )
        if op == 'update_messages':
            if not pid:
                return _resp(400, {'error': 'profileId required'}, event)
            msgs = updates.get('messages', [])
            r = svc.update_messages(user_id, pid, msgs)
            return _resp(200, {'result': r}, event)
        if op == 'get_messages':
            if not pid:
                return _resp(400, {'error': 'profileId required'}, event)
            r = svc.get_messages(user_id, pid)
            return _resp(200, {'messages': r.get('messages', []), 'count': r.get('count', 0)}, event)
        if op == 'check_exists':
            if not pid:
                return _resp(400, {'error': 'profileId required'}, event)
            return _resp(200, svc.check_exists(user_id, pid), event)
        return _resp(400, {'error': f'Unsupported operation: {op}'}, event)

    except ValidationError as e:
        return _resp(400, {'error': e.message}, event)
    except NotFoundError as e:
        return _resp(404, {'error': e.message}, event)
    except AuthorizationError as e:
        return _resp(403, {'error': e.message}, event)
    except ExternalServiceError as e:
        return _resp(502, {'error': e.message}, event)
    except ServiceError as e:
        return _resp(500, {'error': e.message}, event)
    except Exception as e:
        logger.error(f'Error: {e}')
        return _resp(500, {'error': 'Internal server error'}, event)
