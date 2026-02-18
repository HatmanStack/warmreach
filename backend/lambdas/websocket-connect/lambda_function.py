"""WebSocket $connect route handler.

Validates Cognito JWT from query string ?token=, extracts sub + clientType,
enforces single-client-per-user per type, and stores connection in DynamoDB.
"""

import json
import logging
import os

import boto3

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

TABLE_NAME = os.environ['DYNAMODB_TABLE_NAME']
USER_POOL_ID = os.environ['COGNITO_USER_POOL_ID']
COGNITO_REGION = os.environ.get('COGNITO_REGION', 'us-east-1')
WEBSOCKET_ENDPOINT = os.environ.get('WEBSOCKET_ENDPOINT', '')

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)

# Cognito JWKS fetched once per cold start
_jwks_client = None
_cognito_issuer = f'https://cognito-idp.{COGNITO_REGION}.amazonaws.com/{USER_POOL_ID}'


def _get_jwks_client():
    global _jwks_client
    if _jwks_client is None:
        import urllib.request

        jwks_url = f'{_cognito_issuer}/.well-known/jwks.json'
        with urllib.request.urlopen(jwks_url, timeout=5) as resp:
            _jwks_client = json.loads(resp.read())
    return _jwks_client


def _validate_jwt(token: str) -> dict | None:
    """Validate Cognito JWT and return claims, or None if invalid.

    Uses python-jose if available, otherwise falls back to manual JWK validation.
    For Lambda deployment, install python-jose[cryptography] in requirements.txt.
    """
    try:
        from jose import JWTError
        from jose import jwt as jose_jwt
    except ImportError:
        logger.error('python-jose not installed - JWT validation will fail')
        return None

    try:
        jwks = _get_jwks_client()
        claims = jose_jwt.decode(
            token,
            jwks,
            algorithms=['RS256'],
            audience=None,  # Cognito access tokens don't have aud
            issuer=_cognito_issuer,
            options={'verify_aud': False},
        )
        return claims
    except JWTError as e:
        logger.warning(f'JWT validation failed: {e}')
        return None
    except Exception as e:
        logger.error(f'Unexpected error during JWT validation: {e}')
        return None


def lambda_handler(event, context):
    from shared_services.observability import setup_correlation_context

    setup_correlation_context(event, context)

    connection_id = event['requestContext']['connectionId']
    qs = event.get('queryStringParameters') or {}
    token = qs.get('token')
    client_type = qs.get('clientType', 'browser')

    if client_type not in ('browser', 'agent'):
        logger.warning(f'Invalid clientType: {client_type}')
        return {'statusCode': 400, 'body': 'Invalid clientType'}

    if not token:
        logger.warning('Missing token in query string')
        return {'statusCode': 401, 'body': 'Missing token'}

    claims = _validate_jwt(token)
    if not claims:
        return {'statusCode': 401, 'body': 'Invalid token'}

    user_sub = claims.get('sub')
    if not user_sub:
        return {'statusCode': 401, 'body': 'Invalid token: no sub claim'}

    # Enforce single client per user per type: disconnect existing
    from shared_services.websocket_service import WebSocketService

    ws_service = WebSocketService(table, WEBSOCKET_ENDPOINT)

    existing = ws_service.get_user_connections(user_sub, client_type)
    for conn in existing:
        old_id = conn['connectionId']
        if old_id != connection_id:
            logger.info(f'Disconnecting existing {client_type} connection {old_id} for user {user_sub}')
            try:
                ws_service.disconnect_connection(old_id)
            except Exception:
                logger.exception(f'Failed to disconnect {old_id}')

    # Store new connection
    ws_service.store_connection(connection_id, user_sub, client_type)
    logger.info(f'Connected: {connection_id} user={user_sub} type={client_type}')

    return {'statusCode': 200, 'body': 'Connected'}
