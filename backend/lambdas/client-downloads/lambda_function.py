"""Desktop client download URL endpoint.

Returns per-platform download URLs for the WarmReach desktop (Electron)
client. URLs are sourced from environment variables set by CloudFormation
parameters, so they can be updated by re-running `npm run deploy` without
rebuilding the frontend.

Future-friendly: if a URL value is the literal string ``s3://bucket/key``,
this handler will issue a 5-minute presigned URL on each request. Anything
starting with ``http(s)://`` is returned as-is.

Public endpoint — no Cognito auth (Auth: NONE on the route).
"""

import json
import logging
import os

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

PRESIGNED_TTL_SECONDS = 300  # 5 minutes
_s3_client = None


def _get_s3_client():
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client('s3')
    return _s3_client


def _resolve_url(raw: str | None) -> str | None:
    """Pass-through HTTPS URLs; mint presigned URLs for s3:// references.

    Plain http:// is rejected — desktop binaries should never be downloaded
    over an unauthenticated channel. Operators must use https:// or
    s3://bucket/key.
    """
    if not raw:
        return None
    if raw.startswith('https://'):
        return raw
    if raw.startswith('http://'):
        logger.warning('Refusing insecure http:// download URL: %s', raw)
        return None
    if raw.startswith('s3://'):
        without_scheme = raw[len('s3://') :]
        if '/' not in without_scheme:
            logger.warning('Malformed s3:// reference (missing key): %s', raw)
            return None
        bucket, key = without_scheme.split('/', 1)
        try:
            return _get_s3_client().generate_presigned_url(
                'get_object',
                Params={'Bucket': bucket, 'Key': key},
                ExpiresIn=PRESIGNED_TTL_SECONDS,
            )
        except Exception as e:
            logger.exception('Failed to mint presigned URL for %s: %s', raw, e)
            return None
    logger.warning('Unrecognized URL scheme for client download: %s', raw)
    return None


def _cors_headers(event):
    """Mirror the project-wide CORS allowlist for this public endpoint."""
    origin = (event.get('headers') or {}).get('origin') or (event.get('headers') or {}).get('Origin')
    allowed = [
        o.strip().rstrip('/')
        for o in os.environ.get('ALLOWED_ORIGINS', 'http://localhost:5173').split(',')
        if o.strip()
    ]
    headers = {
        'Content-Type': 'application/json',
        'Vary': 'Origin',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
    }
    normalized_origin = (origin or '').rstrip('/')
    if normalized_origin and normalized_origin in allowed:
        headers['Access-Control-Allow-Origin'] = normalized_origin
    return headers


def lambda_handler(event, context):
    method = event.get('requestContext', {}).get('http', {}).get('method', '')
    if method == 'OPTIONS' or event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 204, 'headers': _cors_headers(event), 'body': ''}

    body = {
        'mac': _resolve_url(os.environ.get('CLIENT_DOWNLOAD_MAC')),
        'win': _resolve_url(os.environ.get('CLIENT_DOWNLOAD_WIN')),
        'linux': _resolve_url(os.environ.get('CLIENT_DOWNLOAD_LINUX')),
        'version': os.environ.get('CLIENT_DOWNLOAD_VERSION') or None,
    }
    return {
        'statusCode': 200,
        'headers': _cors_headers(event),
        'body': json.dumps(body),
    }
