import base64
import json
import logging
import os
from typing import Any

import boto3
from botocore.exceptions import ClientError
from services.dynamodb_api_service import DynamoDBApiService

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

# CORS configuration
ALLOWED_ORIGINS_ENV = os.environ.get('ALLOWED_ORIGINS', 'http://localhost:5173')
ALLOWED_ORIGINS = [o.strip() for o in ALLOWED_ORIGINS_ENV.split(',') if o.strip()]

# Thread-local event storage for CORS resolution
_current_event: dict[str, Any] | None = None


def _get_origin_from_event(event: dict[str, Any]) -> str | None:
    headers = event.get('headers') or {}
    origin = headers.get('origin') or headers.get('Origin')
    return origin


def _cors_headers(event: dict[str, Any] | None = None) -> dict[str, str]:
    """Build CORS headers. Only sets ACAO for recognized origins."""
    headers: dict[str, str] = {
        'Content-Type': 'application/json',
        'Vary': 'Origin',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    }
    evt = event or _current_event
    if evt is not None:
        origin = _get_origin_from_event(evt)
        if origin is not None and origin in ALLOWED_ORIGINS:
            headers['Access-Control-Allow-Origin'] = origin
    return headers


def preflight_response(event: dict[str, Any]) -> dict[str, Any]:
    """Return a proper CORS preflight (OPTIONS) response without requiring auth."""
    return {
        'statusCode': 204,
        'headers': _cors_headers(event),
        'body': json.dumps(''),
    }


def _extract_user_id(event: dict[str, Any]) -> str | None:
    """Extract user ID from Cognito JWT claims. Handles both HTTP API v2 and REST API formats."""
    rc = event.get('requestContext') or {}
    auth = rc.get('authorizer') or {}
    # HTTP API v2 JWT authorizer: authorizer.jwt.claims.sub
    jwt_claims = (auth.get('jwt') or {}).get('claims') or {}
    if jwt_claims.get('sub'):
        return jwt_claims['sub']
    # REST API authorizer: authorizer.claims.sub
    rest_claims = auth.get('claims') or {}
    if rest_claims.get('sub'):
        return rest_claims['sub']
    return None


def lambda_handler(event: dict[str, Any], context) -> dict[str, Any]:
    """Main Lambda handler - thin routing layer delegating to DynamoDBApiService."""
    global _current_event
    _current_event = event
    try:
        from shared_services.observability import setup_correlation_context

        setup_correlation_context(event, context)

        logger.info('Received request')

        http_method = (
            event.get('httpMethod') or event.get('requestContext', {}).get('http', {}).get('method') or ''
        ).upper()

        if http_method == 'OPTIONS':
            return preflight_response(event)

        raw_path = event.get('rawPath', '') or event.get('path', '')
        is_profiles_route = '/profiles' in raw_path
        user_id = _extract_user_id(event)

        if is_profiles_route:
            return handle_profiles_route(event, http_method, user_id)

        # --- /dynamodb route handling ---
        if http_method == 'GET':
            profile_id = (event.get('queryStringParameters') or {}).get('profileId')
            if profile_id:
                profile_id_b64 = base64.urlsafe_b64encode(profile_id.encode()).decode()
                item = service.get_profile_metadata(profile_id_b64)
                if not item:
                    return create_response(200, {'message': 'Profile not found', 'profile': None})
                return create_response(200, {'profile': item})

            if not user_id:
                logger.error('No user ID found in JWT token for profile GET')
                return create_response(401, {'error': 'Unauthorized: Missing or invalid JWT token'})

            result = service.get_user_settings(user_id)
            return create_response(200, result)

        if not user_id:
            logger.error('No user ID found in JWT token for POST operation')
            return create_response(401, {'error': 'Authentication required'})

        body = json.loads(event.get('body', '{}')) if event.get('body') else {}
        operation = body.get('operation')

        if operation == 'create':
            result = service.create_bad_contact_profile(user_id, body)
            if 'error' in result:
                return create_response(400, result)
            return create_response(201, result)
        elif operation == 'update_user_settings':
            result = service.update_user_settings(user_id, body)
            if 'error' in result:
                return create_response(400, result)
            return create_response(200, result)
        elif operation == 'update_profile_picture':
            result = service.update_profile_picture(user_id, body)
            if 'error' in result:
                return create_response(400, result)
            return create_response(200, result)
        else:
            return create_response(
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
                    ],
                },
            )

    except ClientError:
        logger.exception('DynamoDB error')
        return create_response(500, {'error': 'Database error'})
    except Exception as e:
        # Intentionally catch broad Exception as top-level handler for Lambda.
        # This ensures malformed requests don't crash the Lambda and always return valid HTTP.
        logger.error(f'Error processing request: {str(e)}')
        return create_response(500, {'error': 'Internal server error'})
    finally:
        _current_event = None


def handle_profiles_route(event: dict[str, Any], http_method: str, user_id: str | None) -> dict[str, Any]:
    """Handle /profiles route - user profile CRUD."""
    if not user_id:
        return create_response(401, {'error': 'Authentication required'})

    if http_method == 'GET':
        try:
            profile_data = service.get_user_profile(user_id)
            return create_response(200, {'success': True, 'data': profile_data})
        except ClientError:
            logger.exception('DynamoDB error in get_user_profile')
            return create_response(500, {'error': 'Database error'})
    elif http_method == 'POST':
        return _update_user_profile(event, user_id)
    else:
        return create_response(405, {'error': f'Method {http_method} not allowed'})


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
            return create_response(400, {'error': f'Unsupported operation: {operation}'})

        result = service.update_user_settings(user_id, body)
        if 'error' in result:
            return create_response(400, result)
        return create_response(200, result)

    except json.JSONDecodeError:
        return create_response(400, {'error': 'Invalid JSON in request body'})


def create_response(status_code: int, body: dict[str, Any]) -> dict[str, Any]:
    """Create standardized API response with CORS headers from current event."""
    return {
        'statusCode': status_code,
        'headers': _cors_headers(),
        'body': json.dumps(body, default=str),
    }
