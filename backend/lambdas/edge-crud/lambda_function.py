"""Edge CRUD Lambda - Routes edge CRUD, notes, and activity operations."""

import json
import logging
import os

import boto3
from errors.exceptions import AuthorizationError, ExternalServiceError, NotFoundError, ServiceError, ValidationError
from shared_services.activity_service import ActivityService
from shared_services.activity_writer import write_activity
from shared_services.edge_data_service import EdgeDataService
from shared_services.edge_opportunity_service import OptimisticConcurrencyError
from shared_services.observability import setup_correlation_context
from shared_services.request_utils import api_response, extract_user_id

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Configuration and clients
_table_name = os.environ.get('DYNAMODB_TABLE_NAME')
if not _table_name:
    raise RuntimeError('FATAL: DYNAMODB_TABLE_NAME environment variable is required')
table = boto3.resource('dynamodb').Table(_table_name)
RAGSTACK_GRAPHQL_ENDPOINT = os.environ.get('RAGSTACK_GRAPHQL_ENDPOINT', '')
RAGSTACK_API_KEY = os.environ.get('RAGSTACK_API_KEY', '')

# Module-level clients for warm container reuse
_ragstack_client = None
_ingestion_service = None
_activity_service = ActivityService(table=table)

if RAGSTACK_GRAPHQL_ENDPOINT and RAGSTACK_API_KEY:
    from shared_services.ingestion_service import IngestionService
    from shared_services.ragstack_client import RAGStackClient

    _ragstack_client = RAGStackClient(RAGSTACK_GRAPHQL_ENDPOINT, RAGSTACK_API_KEY)
    _ingestion_service = IngestionService(_ragstack_client)

_edge_data_service = EdgeDataService(
    table=table,
    ragstack_endpoint=RAGSTACK_GRAPHQL_ENDPOINT,
    ragstack_api_key=RAGSTACK_API_KEY,
    ragstack_client=_ragstack_client,
    ingestion_service=_ingestion_service,
)


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


def _get_user_id(event):
    """Extract user ID from JWT, with DEV_MODE fallback."""
    user_id = extract_user_id(event)
    if user_id:
        return user_id
    if os.environ.get('DEV_MODE', '').lower() == 'true':
        return 'test-user-development'
    return None


def _report_telemetry(user_id: str, operation: str, count: int = 1):
    """Fire-and-forget usage telemetry. Never blocks the response."""
    pass  # Telemetry is handled by edge-insights/edge-pro Lambdas


# ---------------------------------------------------------------------------
# Operation handlers — each takes (body, user_id, event, edge_cache)
# ---------------------------------------------------------------------------


def _handle_get_connections_by_status(body, user_id, event, edge_cache):
    updates = body.get('updates', {})
    r = _edge_data_service.get_connections_by_status(user_id, updates.get('status'))
    return api_response(200, {'connections': r.get('connections', []), 'count': r.get('count', 0)}, event)


def _handle_upsert_status(body, user_id, event, edge_cache):
    pid = body.get('profileId')
    if not pid:
        return api_response(400, {'error': 'profileId required'}, event)
    updates = body.get('updates', {})
    result = _edge_data_service.upsert_status(
        user_id, pid, updates.get('status', 'pending'), updates.get('addedAt'), updates.get('messages')
    )
    write_activity(
        table,
        user_id,
        'connection_status_change',
        metadata={'profileId': pid, 'status': updates.get('status', 'pending')},
    )
    return api_response(200, {'result': result}, event)


def _handle_add_message(body, user_id, event, edge_cache):
    pid = body.get('profileId')
    if not pid:
        return api_response(400, {'error': 'profileId required'}, event)
    updates = body.get('updates', {})
    result = _edge_data_service.add_message(
        user_id, pid, updates.get('message', ''), updates.get('messageType', 'outbound')
    )
    write_activity(table, user_id, 'message_sent', metadata={'profileId': pid})
    return api_response(200, {'result': result}, event)


def _handle_update_messages(body, user_id, event, edge_cache):
    pid = body.get('profileId')
    if not pid:
        return api_response(400, {'error': 'profileId required'}, event)
    updates = body.get('updates', {})
    msgs = updates.get('messages', [])
    r = _edge_data_service.update_messages(user_id, pid, msgs)
    return api_response(200, {'result': r}, event)


def _handle_get_messages(body, user_id, event, edge_cache):
    pid = body.get('profileId')
    if not pid:
        return api_response(400, {'error': 'profileId required'}, event)
    r = _edge_data_service.get_messages(user_id, pid)
    return api_response(200, {'messages': r.get('messages', []), 'count': r.get('count', 0)}, event)


def _handle_check_exists(body, user_id, event, edge_cache):
    pid = body.get('profileId')
    if not pid:
        return api_response(400, {'error': 'profileId required'}, event)
    return api_response(200, _edge_data_service.check_exists(user_id, pid), event)


def _handle_add_note(body, user_id, event, edge_cache):
    pid = body.get('profileId')
    if not pid:
        return api_response(400, {'error': 'profileId required'}, event)
    content = body.get('content', '')
    result = _edge_data_service.add_note(user_id, pid, content)
    write_activity(table, user_id, 'note_added', metadata={'profileId': pid})
    return api_response(200, {'result': result}, event)


def _handle_update_note(body, user_id, event, edge_cache):
    pid = body.get('profileId')
    note_id = body.get('noteId')
    if not pid:
        return api_response(400, {'error': 'profileId required'}, event)
    if not note_id:
        return api_response(400, {'error': 'noteId required'}, event)
    content = body.get('content', '')
    result = _edge_data_service.update_note(user_id, pid, note_id, content)
    return api_response(200, {'result': result}, event)


def _handle_delete_note(body, user_id, event, edge_cache):
    pid = body.get('profileId')
    note_id = body.get('noteId')
    if not pid:
        return api_response(400, {'error': 'profileId required'}, event)
    if not note_id:
        return api_response(400, {'error': 'noteId required'}, event)
    result = _edge_data_service.delete_note(user_id, pid, note_id)
    return api_response(200, {'result': result}, event)


def _handle_get_activity_timeline(body, user_id, event, edge_cache):
    event_type = body.get('eventType')
    event_types = body.get('eventTypes')
    start_date = body.get('startDate')
    end_date = body.get('endDate')
    cursor = body.get('cursor')
    try:
        limit = int(body.get('limit', 50))
    except (ValueError, TypeError):
        limit = 50
    result = _activity_service.get_activity_timeline(
        user_id,
        event_type=event_type,
        event_types=event_types if isinstance(event_types, list) else None,
        start_date=start_date,
        end_date=end_date,
        limit=limit,
        cursor=cursor,
    )
    return api_response(200, result, event)


# ---------------------------------------------------------------------------
# Routing table: 10 operations
# ---------------------------------------------------------------------------

HANDLERS = {
    'get_connections_by_status': _handle_get_connections_by_status,
    'upsert_status': _handle_upsert_status,
    'add_message': _handle_add_message,
    'update_messages': _handle_update_messages,
    'get_messages': _handle_get_messages,
    'check_exists': _handle_check_exists,
    'add_note': _handle_add_note,
    'update_note': _handle_update_note,
    'delete_note': _handle_delete_note,
    'get_activity_timeline': _handle_get_activity_timeline,
}


def lambda_handler(event, context):
    """Route edge CRUD operations."""
    setup_correlation_context(event, context)

    logger.debug(f'Event keys: {list(event.keys())}')
    logger.debug(
        f'Request context: {json.dumps(_sanitize_request_context(event.get("requestContext", {})), default=str)}'
    )

    if event.get('requestContext', {}).get('http', {}).get('method') == 'OPTIONS':
        return api_response(204, '', event)

    try:
        edge_cache = {}
        body = (
            json.loads(event.get('body', '{}'))
            if isinstance(event.get('body'), str)
            else event.get('body') or event or {}
        )
        user_id = _get_user_id(event)
        if not user_id:
            return api_response(401, {'error': 'Unauthorized'}, event)

        op = body.get('operation')
        handler = HANDLERS.get(op)
        if handler:
            return handler(body, user_id, event, edge_cache)

        return api_response(400, {'error': f'Unsupported operation: {op}'}, event)

    except ValidationError as e:
        return api_response(400, {'error': e.message}, event)
    except OptimisticConcurrencyError as e:
        return api_response(409, {'error': e.message, 'code': e.code}, event)
    except NotFoundError as e:
        return api_response(404, {'error': e.message}, event)
    except AuthorizationError as e:
        return api_response(403, {'error': e.message}, event)
    except ExternalServiceError as e:
        return api_response(502, {'error': e.message}, event)
    except ServiceError as e:
        return api_response(500, {'error': e.message}, event)
    except Exception as e:
        logger.error(f'Error: {e}')
        return api_response(500, {'error': 'Internal server error'}, event)
