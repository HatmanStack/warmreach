"""RAGStack Operations Lambda - Search, ingest, and status proxy."""

import json
import logging
import os

import boto3
from errors.exceptions import AuthorizationError, ExternalServiceError, NotFoundError, ServiceError, ValidationError
from shared_services.edge_data_service import EdgeDataService
from shared_services.handler_utils import get_user_id, report_telemetry, sanitize_request_context
from shared_services.monetization import QuotaService
from shared_services.observability import setup_correlation_context
from shared_services.ragstack_proxy_service import RAGStackProxyService
from shared_services.request_utils import api_response

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Configuration and clients
_table_name = os.environ.get('DYNAMODB_TABLE_NAME')
if not _table_name:
    raise RuntimeError('FATAL: DYNAMODB_TABLE_NAME environment variable is required')
table = boto3.resource('dynamodb').Table(_table_name)
RAGSTACK_GRAPHQL_ENDPOINT = os.environ.get('RAGSTACK_GRAPHQL_ENDPOINT', '')
RAGSTACK_API_KEY = os.environ.get('RAGSTACK_API_KEY', '')

# Conditional RAGStack client initialization
_ragstack_client = None
_ingestion_service = None
_quota_service = QuotaService(table) if table else None

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
_ragstack_proxy_service = RAGStackProxyService(
    ragstack_client=_ragstack_client,
    ingestion_service=_ingestion_service,
    table=table,
    edge_data_service=_edge_data_service,
)


def _handle_ragstack(body, user_id, event=None):
    """Handle RAGStack operations: search, ingest, status."""
    if not _ragstack_proxy_service.is_configured():
        return api_response(503, {'error': 'RAGStack not configured'}, event)

    operation = body.get('operation')

    if operation == 'search':
        query = body.get('query', '')
        if not query:
            return api_response(400, {'error': 'query is required'}, event)
        try:
            max_results = min(int(body.get('maxResults', 100)), 200)
        except (TypeError, ValueError):
            return api_response(400, {'error': 'maxResults must be a number'}, event)
        result = _ragstack_proxy_service.ragstack_search(query, max_results)
        report_telemetry(_quota_service, table, user_id, 'ragstack_search')
        return api_response(200, result, event)

    elif operation == 'ingest':
        profile_id = body.get('profileId')
        markdown_content = body.get('markdownContent')
        metadata = body.get('metadata') or {}
        if not isinstance(metadata, dict):
            return api_response(400, {'error': 'metadata must be an object'}, event)
        if not profile_id:
            return api_response(400, {'error': 'profileId is required'}, event)
        if not markdown_content:
            return api_response(400, {'error': 'markdownContent is required'}, event)
        result = _ragstack_proxy_service.ragstack_ingest(profile_id, markdown_content, metadata, user_id)
        report_telemetry(_quota_service, table, user_id, 'ragstack_ingest')
        return api_response(200, result, event)

    elif operation == 'status':
        document_id = body.get('documentId')
        if not document_id:
            return api_response(400, {'error': 'documentId is required'}, event)
        result = _ragstack_proxy_service.ragstack_status(document_id)
        return api_response(200, result, event)

    else:
        return api_response(400, {'error': f'Unsupported ragstack operation: {operation}'}, event)


def lambda_handler(event, context):
    """Route RAGStack operations."""
    setup_correlation_context(event, context)

    logger.debug(f'Event keys: {list(event.keys())}')
    logger.debug(
        f'Request context: {json.dumps(sanitize_request_context(event.get("requestContext", {})), default=str)}'
    )

    # Handle CORS preflight
    if event.get('requestContext', {}).get('http', {}).get('method') == 'OPTIONS':
        return api_response(204, '', event)

    try:
        body = (
            json.loads(event.get('body', '{}'))
            if isinstance(event.get('body'), str)
            else event.get('body') or event or {}
        )
        user_id = get_user_id(event)
        if not user_id:
            return api_response(401, {'error': 'Unauthorized'}, event)

        return _handle_ragstack(body, user_id, event)

    except ValidationError as e:
        return api_response(400, {'error': e.message}, event)
    except NotFoundError as e:
        return api_response(404, {'error': e.message}, event)
    except AuthorizationError as e:
        return api_response(403, {'error': e.message}, event)
    except ExternalServiceError as e:
        return api_response(502, {'error': e.message}, event)
    except ServiceError as e:
        return api_response(500, {'error': e.message}, event)
    except Exception:
        logger.exception('Unexpected error in ragstack-ops handler')
        return api_response(500, {'error': 'Internal server error'}, event)
