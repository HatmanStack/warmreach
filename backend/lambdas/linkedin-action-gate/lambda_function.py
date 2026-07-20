"""LinkedIn action gate — meters user-initiated LinkedIn actions.

The manual counterpart to the agent's ``agent-action-task/gate_dispatch``: it
reserves the shared ``li-actions`` quota bucket before a user-initiated
connect / message / follow, then forwards the request to the community-clean
``command-dispatch`` Lambda (ADR-8 — no pro/agent/quota logic is ever added to
command-dispatch itself). Because the agent and the UI both funnel into
command-dispatch but each reserves exactly once (the agent in gate_dispatch,
the UI here), a real LinkedIn action is never double-metered.

Over the daily/monthly li-actions cap → 429; a metering-infra failure → 503
(fail closed). Metering is a no-op in the community edition, where the injected
``QuotaService`` is a stub, so this is a thin passthrough there.
"""

import json
import logging
import os

import boto3
from botocore.exceptions import ClientError
from errors.exceptions import NotFoundError, QuotaExceededError
from shared_services.monetization import QuotaService, ensure_tier_exists
from shared_services.observability import setup_correlation_context
from shared_services.request_utils import api_response, extract_user_id

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

TABLE_NAME = os.environ['DYNAMODB_TABLE_NAME']
COMMAND_DISPATCH_FUNCTION_NAME = os.environ['COMMAND_DISPATCH_FUNCTION_NAME']

table = boto3.resource('dynamodb').Table(TABLE_NAME)
lambda_client = boto3.client('lambda')
_quota_service = QuotaService(table)

_ALLOWED_METHODS = 'POST,OPTIONS'

# User-initiated outbound LinkedIn actions metered against the shared li-actions
# bucket. Mirrors the agent's COMMAND_TYPE_BY_ACTION targets (connect / message /
# follow). Read-only ops (search, profile-init) are NOT gated and never reach here.
LI_ACTION_COMMAND_TYPES = frozenset(
    {
        'linkedin:add-connection',
        'linkedin:send-message',
        'linkedin:follow-profile',
    }
)


def _release(user_id: str, command_type: str) -> None:
    """Best-effort refund of a prior li-actions reservation. Never raises."""
    try:
        _quota_service.release_li_action_usage(user_id, command_type)
    except Exception:
        logger.exception('release_li_action_usage failed for %s', command_type)


def _synthesize_command_event(user_id: str, command_type: str, payload: dict) -> dict:
    """Build an authenticated command-dispatch event. This gate is a trusted
    server component that has already verified the caller's JWT, so it injects
    that identity as the sub — the same pattern the agent's gate_dispatch uses."""
    return {
        'httpMethod': 'POST',
        'rawPath': '/commands',
        'requestContext': {
            'http': {'method': 'POST'},
            'authorizer': {'jwt': {'claims': {'sub': user_id}}},
        },
        'headers': {},
        'body': json.dumps({'type': command_type, 'payload': payload}),
    }


def lambda_handler(event, context):
    setup_correlation_context(event, context)

    method = (event.get('httpMethod') or event.get('requestContext', {}).get('http', {}).get('method', '')).upper()
    if method == 'OPTIONS':
        return api_response(204, '', event, allowed_methods=_ALLOWED_METHODS)

    user_id = extract_user_id(event)
    if not user_id:
        return api_response(401, {'error': 'Authentication required'}, event, allowed_methods=_ALLOWED_METHODS)

    raw_body = event.get('body')
    try:
        body = json.loads(raw_body) if raw_body else {}
    except json.JSONDecodeError:
        return api_response(400, {'error': 'Invalid JSON body'}, event, allowed_methods=_ALLOWED_METHODS)
    if not isinstance(body, dict):
        # A valid-JSON scalar/array (e.g. "hi" or [1,2]) would otherwise make
        # body.get(...) raise AttributeError → an unhandled 500.
        return api_response(
            400, {'error': 'Request body must be a JSON object'}, event, allowed_methods=_ALLOWED_METHODS
        )

    command_type = body.get('type')
    if command_type not in LI_ACTION_COMMAND_TYPES:
        # This endpoint gates outbound LinkedIn actions only; anything else
        # belongs on /commands.
        return api_response(
            400,
            {'error': 'Unsupported LinkedIn action type', 'code': 'UNSUPPORTED_ACTION'},
            event,
            allowed_methods=_ALLOWED_METHODS,
        )

    # Best-effort tier auto-provision so a brand-new user's first action isn't
    # denied for a missing tier row (recoverable on a later call; never blocks).
    try:
        ensure_tier_exists(table, user_id)
    except Exception:
        logger.exception('Tier auto-provision failed for %s (non-blocking)', command_type)

    # Reserve the shared li-actions bucket BEFORE dispatching (enforcing). No-op
    # in the community edition (stub QuotaService).
    try:
        _quota_service.reserve_li_action_usage(user_id, command_type)
    except QuotaExceededError:
        return api_response(
            429,
            {
                'error': 'Daily LinkedIn action limit reached. Please try again later.',
                'code': 'LI_ACTION_QUOTA_EXCEEDED',
            },
            event,
            allowed_methods=_ALLOWED_METHODS,
        )
    except (ClientError, NotFoundError):
        logger.exception('reserve_li_action_usage failed for %s, denying request (fail closed)', command_type)
        return api_response(
            503,
            {'error': 'Quota service unavailable, please retry', 'code': 'QUOTA_UNAVAILABLE'},
            event,
            allowed_methods=_ALLOWED_METHODS,
        )

    # Forward to the community-clean command-dispatch Lambda (ADR-8).
    try:
        resp = lambda_client.invoke(
            FunctionName=COMMAND_DISPATCH_FUNCTION_NAME,
            InvocationType='RequestResponse',
            Payload=json.dumps(_synthesize_command_event(user_id, command_type, body.get('payload', {}))).encode(
                'utf-8'
            ),
        )
        result = json.loads(resp['Payload'].read())
    except Exception:
        logger.exception('command-dispatch invoke failed for %s', command_type)
        _release(user_id, command_type)
        return api_response(
            503, {'error': 'Dispatch unavailable, please retry'}, event, allowed_methods=_ALLOWED_METHODS
        )

    status_code = result.get('statusCode', 502)
    try:
        body_obj = json.loads(result.get('body') or '{}')
    except (TypeError, json.JSONDecodeError):
        body_obj = {}

    # command-dispatch did not accept the send (rate-limited, agent offline, etc.)
    # — refund so an un-dispatched action doesn't burn the daily cap. (A 200 means
    # dispatched to the agent; an action that later fails on-device still counts,
    # mirroring the agent gate's dispatch-time metering.)
    if status_code != 200:
        _release(user_id, command_type)

    # Re-emit through api_response so CORS headers match the /linkedin-actions route.
    return api_response(status_code, body_obj, event, allowed_methods=_ALLOWED_METHODS)
