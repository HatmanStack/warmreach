import base64
import json
import logging
import os
from typing import Any

from botocore.exceptions import ClientError
from services.dynamodb_api_service import DynamoDBApiService
from shared_services.activity_writer import write_activity
from shared_services.aws_clients import dynamodb_resource
from shared_services.request_utils import api_response, extract_user_id

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients at module level (outside handler) for Lambda best practice:
# This allows connection reuse across warm invocations, reducing cold start latency.
# See: https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html
dynamodb = dynamodb_resource()

# Environment variables
TABLE_NAME = os.environ['DYNAMODB_TABLE_NAME']

table = dynamodb.Table(TABLE_NAME)
service = DynamoDBApiService(table)

# Billing (Stripe checkout + subscription management) is a WarmReach Pro
# feature. In pro it lives in a separate billing-api Lambda on POST /billing;
# the community edition ships no billing surface, so there is nothing to stub
# here. The ALLOWED_ORIGINS list that used to sit at this spot only fed the
# checkout redirect-URL validator and was already unused in this edition.

_ALLOWED_METHODS = 'GET,POST,PUT,DELETE,OPTIONS'


def _resp(status_code, body, event=None):
    """Shorthand for api_response with this handler's allowed methods."""
    return api_response(status_code, body, event, allowed_methods=_ALLOWED_METHODS)


# ---------------------------------------------------------------------------
# POST operation handlers — each takes (body, user_id, event) and returns a response
# ---------------------------------------------------------------------------


def _handle_create(body, user_id, event):
    result = service.create_bad_contact_profile(user_id, body)
    if 'error' in result:
        return _resp(400, result, event)
    return _resp(201, result, event)


def _handle_update_user_settings(body, user_id, event):
    result = service.update_user_settings(user_id, body)
    if 'error' in result:
        return _resp(400, result, event)
    write_activity(table, user_id, 'user_settings_updated', metadata={'operation': 'update_user_settings'})
    return _resp(200, result, event)


def _handle_update_profile_picture(body, user_id, event):
    result = service.update_profile_picture(user_id, body)
    if 'error' in result:
        return _resp(400, result, event)
    write_activity(table, user_id, 'profile_metadata_updated', metadata={'operation': 'update_profile_picture'})
    return _resp(200, result, event)


def _handle_increment_daily_scrape_count(body, user_id, event):
    date = body.get('date')
    if not date:
        return _resp(400, {'error': 'date is required'}, event)
    result = service.increment_daily_scrape_count(user_id, date)
    return _resp(200, result, event)


def _handle_save_import_checkpoint(body, user_id, event):
    checkpoint = body.get('checkpoint')
    if not checkpoint:
        return _resp(400, {'error': 'checkpoint is required'}, event)
    result = service.save_import_checkpoint(user_id, checkpoint)
    return _resp(200, result, event)


def _handle_clear_import_checkpoint(body, user_id, event):
    result = service.clear_import_checkpoint(user_id)
    return _resp(200, result, event)


def _handle_complete_onboarding_step(body, user_id, event):
    """Record an onboarding step completion or skip as activity events."""
    step = body.get('step')
    if not step or not isinstance(step, str) or not step.strip():
        return _resp(400, {'error': 'step is required and must be a non-empty string'}, event)

    skipped = body.get('skipped', False)

    if skipped:
        write_activity(table, user_id, 'onboarding_skipped', metadata={'step': step})
    else:
        write_activity(table, user_id, 'onboarding_step_completed', metadata={'step': step})

    if step == 'completed':
        write_activity(table, user_id, 'onboarding_completed')

    return _resp(200, {'success': True}, event)


# ---------------------------------------------------------------------------
# Legal document acceptance
# ---------------------------------------------------------------------------

_legal_service = None


def _get_legal_service():
    global _legal_service
    if _legal_service is None:
        from shared_services.legal_acceptance_service import LegalAcceptanceService

        _legal_service = LegalAcceptanceService(table)
    return _legal_service


def _handle_get_legal_status(body, user_id, event):
    """Which documents this user still has to accept, and at what version."""
    svc = _get_legal_service()
    outstanding = svc.outstanding_documents(user_id)
    return _resp(
        200,
        {
            'outstanding': outstanding,
            'accepted': svc.get_acceptances(user_id),
            'allAccepted': not outstanding,
        },
        event,
    )


def _handle_accept_legal_documents(body, user_id, event):
    """Record acceptance of one or more documents at their current versions."""
    document_ids = body.get('documentIds')
    if not isinstance(document_ids, list) or not document_ids:
        return _resp(400, {'error': 'documentIds must be a non-empty list'}, event)
    if not all(isinstance(d, str) for d in document_ids):
        return _resp(400, {'error': 'documentIds must be strings'}, event)

    result = _get_legal_service().record_acceptance(user_id, document_ids)
    return _resp(200, result, event)


# ---------------------------------------------------------------------------
# Data subject rights (GDPR Art. 15 / 17, CCPA)
# ---------------------------------------------------------------------------

_data_rights_service = None


def _get_data_rights_service():
    global _data_rights_service
    if _data_rights_service is None:
        from shared_services.data_rights_service import DataRightsService

        _data_rights_service = DataRightsService(table)
    return _data_rights_service


def _handle_export_my_data(body, user_id, event):
    """Return everything held about the requesting account."""
    from shared_services.data_rights_service import to_json

    result = _get_data_rights_service().export_user_data(user_id)
    write_activity(table, user_id, 'data_exported', metadata={'itemCount': result.get('itemCount', 0)})
    # api_response serialises with default=str, which would turn DynamoDB
    # Decimals into strings and hand the subject "12" instead of 12. Normalise
    # through to_json first so counters stay numbers.
    return _resp(200, json.loads(to_json(result)), event)


def _handle_delete_my_account(body, user_id, event):
    """Erase the requesting account's data. Irreversible.

    Requires an explicit confirmation field. An erasure triggered by a
    mis-routed request is unrecoverable, so the caller has to say so twice.
    """
    if body.get('confirm') != 'DELETE MY ACCOUNT':
        return _resp(
            400,
            {
                'error': 'Confirmation required',
                'code': 'CONFIRMATION_REQUIRED',
                'hint': 'Send {"confirm": "DELETE MY ACCOUNT"} to proceed. This cannot be undone.',
            },
            event,
        )

    # Deliberately NOT written as an ACTIVITY# item: that lives in the user's own
    # partition and would be swept up by the very erasure it documents, leaving
    # no trace the account was ever asked to be deleted. A structured log line
    # outlives the data it describes, which is the point of an audit record.
    logger.info(
        'account_deletion_requested',
        extra={'user_id': user_id, 'operation': 'delete_my_account'},
    )

    result = _get_data_rights_service().delete_user_data(user_id)
    logger.info(
        'account_deletion_result',
        extra={
            'user_id': user_id,
            'operation': 'delete_my_account',
            'status_code': 200 if result.get('complete') else 500,
        },
    )
    if not result.get('complete'):
        # Reporting 200 on a partial erasure would tell the subject their data
        # is gone when some of it is not. The operation is idempotent, so a
        # retry finishes it.
        return _resp(500, {**result, 'error': 'Erasure incomplete, please retry'}, event)
    return _resp(200, result, event)


# ---------------------------------------------------------------------------
# POST operation routing table
# ---------------------------------------------------------------------------

POST_HANDLERS = {
    'create': _handle_create,
    'update_user_settings': _handle_update_user_settings,
    'update_profile_picture': _handle_update_profile_picture,
    'increment_daily_scrape_count': _handle_increment_daily_scrape_count,
    'save_import_checkpoint': _handle_save_import_checkpoint,
    'clear_import_checkpoint': _handle_clear_import_checkpoint,
    'complete_onboarding_step': _handle_complete_onboarding_step,
    'get_legal_status': _handle_get_legal_status,
    'accept_legal_documents': _handle_accept_legal_documents,
    'export_my_data': _handle_export_my_data,
    'delete_my_account': _handle_delete_my_account,
}

# ---------------------------------------------------------------------------
# GET operation routing table
# ---------------------------------------------------------------------------


def _handle_get_daily_scrape_count(event, user_id):
    if not user_id:
        return _resp(401, {'error': 'Authentication required'}, event)
    date = (event.get('queryStringParameters') or {}).get('date')
    if not date:
        return _resp(400, {'error': 'date is required'}, event)
    result = service.get_daily_scrape_count(user_id, date)
    return _resp(200, result, event)


def _handle_get_import_checkpoint(event, user_id):
    if not user_id:
        return _resp(401, {'error': 'Authentication required'}, event)
    result = service.get_import_checkpoint(user_id)
    return _resp(200, result, event)


GET_HANDLERS = {
    'get_daily_scrape_count': _handle_get_daily_scrape_count,
    'get_import_checkpoint': _handle_get_import_checkpoint,
}


def lambda_handler(event: dict[str, Any], context) -> dict[str, Any]:
    """Main Lambda handler - thin routing layer delegating to DynamoDBApiService."""
    try:
        from shared_services.observability import setup_correlation_context

        setup_correlation_context(event, context)

        logger.info('Received request')

        http_method = (
            event.get('httpMethod') or event.get('requestContext', {}).get('http', {}).get('method') or ''
        ).upper()

        if http_method == 'OPTIONS':
            return api_response(204, '', event, allowed_methods=_ALLOWED_METHODS)

        raw_path = event.get('rawPath', '') or event.get('path', '')
        is_profiles_route = '/profiles' in raw_path
        user_id = extract_user_id(event)

        if is_profiles_route:
            return handle_profiles_route(event, http_method, user_id)

        # --- /dynamodb route handling ---
        if http_method == 'GET':
            profile_id = (event.get('queryStringParameters') or {}).get('profileId')
            if profile_id:
                profile_id_b64 = base64.urlsafe_b64encode(profile_id.encode()).decode()
                item = service.get_profile_metadata(profile_id_b64)
                if not item:
                    return _resp(200, {'message': 'Profile not found', 'profile': None}, event)
                return _resp(200, {'profile': item}, event)

            # Handle operation-based GET requests via routing table
            operation = (event.get('queryStringParameters') or {}).get('operation')
            get_handler = GET_HANDLERS.get(operation) if isinstance(operation, str) else None
            if get_handler:
                return get_handler(event, user_id)

            if not user_id:
                logger.error('No user ID found in JWT token for profile GET')
                return _resp(401, {'error': 'Unauthorized: Missing or invalid JWT token'}, event)

            result = service.get_user_settings(user_id)
            return _resp(200, result, event)

        if not user_id:
            logger.error('No user ID found in JWT token for POST operation')
            return _resp(401, {'error': 'Authentication required'}, event)

        body = json.loads(event.get('body', '{}')) if event.get('body') else {}
        operation = body.get('operation')

        # Dispatch via POST routing table
        # Distinct names: GET and POST handlers have different arities, and reusing
        # one `handler` binding made mypy infer the GET signature for both, hiding
        # the arity mismatch behind an unchecked union.
        post_handler = POST_HANDLERS.get(operation) if isinstance(operation, str) else None
        if post_handler:
            return post_handler(body, user_id, event)

        return _resp(
            400,
            {
                'error': f'Unsupported operation: {operation}',
                'supported_operations': list(POST_HANDLERS.keys()),
            },
            event,
        )

    except ClientError:
        logger.exception('DynamoDB error')
        return _resp(500, {'error': 'Database error'}, event)
    except Exception as e:
        # Intentionally catch broad Exception as top-level handler for Lambda.
        # This ensures malformed requests don't crash the Lambda and always return valid HTTP.
        logger.error('Error processing request: %s', str(e))
        return _resp(500, {'error': 'Internal server error'}, event)


def handle_profiles_route(event: dict[str, Any], http_method: str, user_id: str | None) -> dict[str, Any]:
    """Handle /profiles route - user profile CRUD."""
    if not user_id:
        return _resp(401, {'error': 'Authentication required'}, event)

    if http_method == 'GET':
        try:
            profile_data = service.get_user_profile(user_id)
            return _resp(200, {'success': True, 'data': profile_data}, event)
        except ClientError:
            logger.exception('DynamoDB error in get_user_profile')
            return _resp(500, {'error': 'Database error'}, event)
    elif http_method == 'POST':
        return _update_user_profile(event, user_id)
    else:
        return _resp(405, {'error': f'Method {http_method} not allowed'}, event)


def _update_user_profile(event: dict[str, Any], user_id: str) -> dict[str, Any]:
    """POST /profiles - Update user profile via service."""
    try:
        raw_body = event.get('body', '{}')
        if isinstance(raw_body, str):
            body = json.loads(raw_body or '{}')
        elif raw_body is None:
            body = {}
        else:
            body = raw_body

        operation = body.get('operation', 'update_user_settings')
        if operation != 'update_user_settings':
            return _resp(400, {'error': f'Unsupported operation: {operation}'}, event)

        result = service.update_user_settings(user_id, body)
        if 'error' in result:
            return _resp(400, result, event)
        write_activity(table, user_id, 'profile_metadata_updated', metadata={'operation': 'update_user_profile'})
        return _resp(200, result, event)

    except json.JSONDecodeError:
        return _resp(400, {'error': 'Invalid JSON in request body'}, event)
