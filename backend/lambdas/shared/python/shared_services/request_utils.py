"""Shared request utilities for Lambda handlers.

Provides user ID extraction, CORS header construction, and API response formatting.
"""

import json
import os

ALLOWED_ORIGINS_ENV = os.environ.get('ALLOWED_ORIGINS', 'http://localhost:5173')
_DEFAULT_ALLOWED_ORIGINS = [o.strip() for o in ALLOWED_ORIGINS_ENV.split(',') if o.strip()]


def _get_origin(event):
    """Extract the Origin header from the event (case-insensitive)."""
    headers = event.get('headers') or {}
    return headers.get('origin') or headers.get('Origin')


def extract_user_id(event):
    """Extract Cognito sub from JWT claims.

    Handles both HTTP API v2 (authorizer.jwt.claims.sub) and
    REST API (authorizer.claims.sub) formats.

    Returns None if not found.
    """
    rc = event.get('requestContext') or {}
    auth = rc.get('authorizer') or {}
    # HTTP API v2 JWT authorizer
    jwt_claims = (auth.get('jwt') or {}).get('claims') or {}
    if jwt_claims.get('sub'):
        return jwt_claims['sub']
    # REST API authorizer
    rest_claims = auth.get('claims') or {}
    return rest_claims.get('sub')


def cors_headers(event, allowed_origins=None, allowed_methods='POST,OPTIONS'):
    """Build CORS header dict.

    Args:
        event: API Gateway event (used to extract Origin header).
        allowed_origins: List of allowed origins. Defaults to ALLOWED_ORIGINS env var.
        allowed_methods: Allowed HTTP methods string.

    Returns:
        Dict of CORS headers.
    """
    origins = allowed_origins if allowed_origins is not None else _DEFAULT_ALLOWED_ORIGINS
    origin = _get_origin(event) if event else None

    headers = {
        'Content-Type': 'application/json',
        'Vary': 'Origin',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': allowed_methods,
    }

    if origin is not None and origin in origins:
        headers['Access-Control-Allow-Origin'] = origin

    return headers


def api_error(
    code,
    message,
    status_code=400,
    event=None,
    details=None,
    allowed_origins=None,
    allowed_methods='POST,OPTIONS',
):
    """Build an error Lambda proxy response with the structured error schema.

    Canonical shape::

        {
            "error": {
                "code": "VALIDATION_ERROR",
                "message": "Human-readable message",
                "details": {...}   # optional
            }
        }

    Ad-hoc ``{"error": "..."}`` shapes emitted by older handlers remain valid
    responses — the frontend parser accepts both for a rollout window. Prefer
    this helper for any NEW error response.

    Args:
        code: Machine-readable error code (e.g. ``VALIDATION_ERROR``).
        message: Human-readable message shown to the user.
        status_code: HTTP status (defaults 400).
        event: API Gateway event for CORS resolution. Optional.
        details: Optional dict with structured details.
        allowed_origins: Override allowed origins list.
        allowed_methods: Allowed HTTP methods string.
    """
    body = {'error': {'code': code, 'message': message}}
    if details is not None:
        body['error']['details'] = details
    return api_response(
        status_code,
        body,
        event=event,
        allowed_origins=allowed_origins,
        allowed_methods=allowed_methods,
    )


def api_response(status_code, body, event=None, allowed_origins=None, allowed_methods='POST,OPTIONS'):
    """Build a complete Lambda proxy response.

    Args:
        status_code: HTTP status code.
        body: Response body (will be JSON-serialized).
        event: API Gateway event for CORS origin resolution. Optional.
        allowed_origins: Override allowed origins list. Optional.
        allowed_methods: Allowed HTTP methods string.

    Returns:
        Lambda proxy response dict.
    """
    headers = (
        cors_headers(event, allowed_origins, allowed_methods)
        if event
        else cors_headers({}, allowed_origins, allowed_methods)
    )
    return {
        'statusCode': status_code,
        'headers': headers,
        'body': json.dumps(body, default=str),
    }
