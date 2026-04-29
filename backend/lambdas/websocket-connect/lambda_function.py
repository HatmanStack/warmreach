"""WebSocket $connect route handler.

Validates Cognito JWT from query string ?token=, extracts sub + clientType,
enforces single-client-per-user per type, and stores connection in DynamoDB.
"""

import json
import logging
import os
import time

import boto3
from shared_services.observability import setup_correlation_context

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

TABLE_NAME = os.environ['DYNAMODB_TABLE_NAME']
USER_POOL_ID = os.environ['COGNITO_USER_POOL_ID']
COGNITO_REGION = os.environ.get('COGNITO_REGION', 'us-east-1')
WEBSOCKET_ENDPOINT = os.environ.get('WEBSOCKET_ENDPOINT', '')
if not os.environ.get('COGNITO_CLIENT_ID'):
    logger.warning(
        'COGNITO_CLIENT_ID not set — cross-application JWT reuse check is disabled. This MUST be set in production.'
    )

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)

# Cognito JWKS cache (ADR-A: explicit fail-fast timeout with a single retry;
# serve stale on transient fetch failure). Module-level so cache persists
# across warm invocations.
_JWKS_CACHE: dict = {'data': None, 'fetched_at': 0.0}
_JWKS_TTL_SECONDS = 6 * 60 * 60  # 6 hours
_JWKS_STALE_GRACE_SECONDS = 24 * 60 * 60  # serve stale up to 24 h on fetch failure
_JWKS_FETCH_TIMEOUT = 2.0
_cognito_issuer = f'https://cognito-idp.{COGNITO_REGION}.amazonaws.com/{USER_POOL_ID}'


class JWKSUnavailableError(RuntimeError):
    """Raised when JWKS cannot be fetched and no usable cached copy exists."""


def fetch_jwks():
    """Fetch JWKS with a 2s timeout and one retry. Raises on both-attempts failure."""
    import urllib.request

    jwks_url = f'{_cognito_issuer}/.well-known/jwks.json'
    last_exc = None
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(  # nosec B310 - URL from Cognito issuer config, not user input
                jwks_url, timeout=_JWKS_FETCH_TIMEOUT
            ) as resp:
                return json.loads(resp.read())
        except Exception as exc:  # noqa: BLE001 - retry once, then re-raise
            last_exc = exc
            logger.warning('JWKS fetch attempt %d failed: %s', attempt, exc)
    assert last_exc is not None
    raise last_exc


def _get_jwks_client():
    """Return JWKS, refreshing if TTL expired; serve stale on fetch failure."""
    now = time.time()
    cached = _JWKS_CACHE.get('data')
    fetched_at = _JWKS_CACHE.get('fetched_at', 0.0)
    age = now - fetched_at

    if cached is not None and age < _JWKS_TTL_SECONDS:
        return cached

    try:
        fresh = fetch_jwks()
        _JWKS_CACHE['data'] = fresh
        _JWKS_CACHE['fetched_at'] = now
        return fresh
    except Exception as exc:  # noqa: BLE001
        if cached is not None and age < _JWKS_STALE_GRACE_SECONDS:
            logger.warning('JWKS fetch failed (%s); serving stale cache (age=%.0fs)', exc, age)
            return cached
        logger.error('JWKS fetch failed and no usable cache available: %s', exc)
        raise JWKSUnavailableError(str(exc)) from exc


def _validate_jwt(token: str) -> dict | None:
    """Validate Cognito JWT and return claims, or None if invalid.

    Uses PyJWT if available, otherwise falls back to manual JWK validation.
    For Lambda deployment, install PyJWT[crypto]==2.9.0 in requirements.txt.
    """
    try:
        import jwt
    except ImportError:
        logger.error('PyJWT not installed - JWT validation will fail')
        return None

    try:
        jwks = _get_jwks_client()
    except JWKSUnavailableError:
        raise
    try:
        unverified_header = jwt.get_unverified_header(token)
        kid = unverified_header.get('kid')
        if not kid:
            logger.warning('JWT missing kid in header')
            return None

        # Find matching key in JWKS
        matching_key = None
        for key in jwks.get('keys', []):
            if key.get('kid') == kid:
                matching_key = key
                break

        if not matching_key:
            logger.warning('No matching key found in JWKS for kid: %s', kid)
            return None

        # Construct RSA public key object
        public_key = jwt.algorithms.RSAAlgorithm.from_jwk(matching_key)

        # Decode with explicit algorithm restriction (fix for CVE-2025-61152)
        claims = jwt.decode(
            token,
            key=public_key,
            algorithms=['RS256'],
            issuer=_cognito_issuer,
            options={'verify_aud': False},
        )

        # Validate client_id / aud claim to prevent cross-application JWT
        # reuse. Cognito access tokens carry the client identifier in the
        # `client_id` claim; Cognito ID tokens carry it in `aud`. We accept
        # either so the same token plumbing works for HTTP API auth and the
        # WebSocket connect handshake.
        # Read os.environ at call time so tests can patch it; the module-init
        # warning above surfaces the unset case at cold start.
        expected_client_id = os.environ.get('COGNITO_CLIENT_ID', '')
        if expected_client_id:
            token_client_id = claims.get('client_id') or claims.get('aud') or ''
            if token_client_id != expected_client_id:
                logger.warning(
                    'JWT client_id mismatch: expected=%s, got=%s (token_use=%s)',
                    expected_client_id,
                    token_client_id,
                    claims.get('token_use', '?'),
                )
                return None

        return claims
    except jwt.InvalidTokenError as e:
        logger.warning('JWT validation failed: %s', e)
        return None
    except Exception:
        logger.exception('Unexpected error during JWT validation')
        return None


def lambda_handler(event, context):
    setup_correlation_context(event, context)

    connection_id = event['requestContext']['connectionId']
    qs = event.get('queryStringParameters') or {}
    token = qs.get('token')
    client_type = qs.get('clientType', 'browser')

    if client_type not in ('browser', 'agent'):
        logger.warning('Invalid clientType: %s', client_type)
        return {'statusCode': 400, 'body': 'Invalid clientType'}

    if not token:
        logger.warning('Missing token in query string')
        return {'statusCode': 401, 'body': 'Missing token'}

    try:
        claims = _validate_jwt(token)
    except JWKSUnavailableError:
        return {'statusCode': 500, 'body': 'JWKS unavailable'}
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
            logger.info('Disconnecting existing %s connection %s for user %s', client_type, old_id, user_sub)
            try:
                ws_service.disconnect_connection(old_id)
            except Exception:
                logger.exception('Failed to disconnect %s', old_id)

    # Store new connection
    ws_service.store_connection(connection_id, user_sub, client_type)
    logger.info('Connected: %s user=%s type=%s', connection_id, user_sub, client_type)

    # Notify the frontend(s) about agent reachability so the install-prompt
    # / "no agent" UI can flip without a page reload. Failures are
    # non-fatal — the connection itself is established.
    try:
        if client_type == 'agent':
            for browser in ws_service.get_user_connections(user_sub, 'browser'):
                ws_service.send_to_connection(
                    browser['connectionId'],
                    {'action': 'agent_status', 'connected': True},
                )
        elif client_type == 'browser':
            agent_online = bool(ws_service.get_user_connections(user_sub, 'agent'))
            ws_service.send_to_connection(
                connection_id,
                {'action': 'agent_status', 'connected': agent_online},
            )
    except Exception:
        logger.exception('agent_status broadcast failed (non-fatal)')

    return {'statusCode': 200, 'body': 'Connected'}
