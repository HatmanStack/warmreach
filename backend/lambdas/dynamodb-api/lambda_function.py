import base64
import json
import logging
import os
from typing import Any

import boto3
from botocore.exceptions import ClientError
from services.dynamodb_api_service import DynamoDBApiService
from shared_services.activity_writer import write_activity
from shared_services.request_utils import api_response, extract_user_id

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients at module level (outside handler) for Lambda best practice:
# This allows connection reuse across warm invocations, reducing cold start latency.
# See: https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html
dynamodb = boto3.resource('dynamodb')

# Environment variables
TABLE_NAME = os.environ['DYNAMODB_TABLE_NAME']

table = dynamodb.Table(TABLE_NAME)
service = DynamoDBApiService(table)

# CORS configuration — retained for _is_allowed_redirect_url validation
ALLOWED_ORIGINS_ENV = os.environ.get('ALLOWED_ORIGINS', 'http://localhost:5173')
ALLOWED_ORIGINS = [o.strip() for o in ALLOWED_ORIGINS_ENV.split(',') if o.strip()]

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
            handler = GET_HANDLERS.get(operation) if operation else None
            if handler:
                return handler(event, user_id)

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
        handler = POST_HANDLERS.get(operation)
        if handler:
            return handler(body, user_id, event)

        return _resp(
            400,
            {
                'error': f'Unsupported operation: {operation}',
                'supported_operations': [
                    'create',
                    'get_details',
                    'get_user_settings',
                    'update_user_settings',
                    'update_user_profile',
                    'update_profile_picture',
                    'increment_daily_scrape_count',
                    'save_import_checkpoint',
                    'clear_import_checkpoint',
                ],
            },
            event,
        )

    except ClientError:
        logger.exception('DynamoDB error')
        return _resp(500, {'error': 'Database error'}, event)
    except Exception as e:
        # Intentionally catch broad Exception as top-level handler for Lambda.
        # This ensures malformed requests don't crash the Lambda and always return valid HTTP.
        logger.error(f'Error processing request: {str(e)}')
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
