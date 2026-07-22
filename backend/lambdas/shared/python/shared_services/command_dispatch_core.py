"""Community-clean command-creation core.

Shared, agent- and quota-agnostic command-creation path extracted from the
``command-dispatch`` Lambda so callers can create a ``COMMAND#`` + WebSocket
dispatch **in-process** instead of paying a Lambda-to-Lambda network hop.

``command-dispatch`` (the ``POST /commands`` handler) and both send gates
(``linkedin-action-gate`` and the agent ``gate_dispatch``) call
:func:`create_command`. Per ADR-009 this module MUST stay community-clean: it
imports nothing pro/agent/quota and contains no quota or agent branching. Quota
reservation lives in the gates, where the community/pro split is handled by the
``monetization.py`` overlay (stub ``QuotaService`` in the community edition).

:func:`create_command` returns the exact ``(status_code, body)`` shape the
handler returned before the extraction: 200 + ``{'commandId','status':'dispatched'}``,
409 no-agent, 429 rate-limited, 503 disconnected/rate-limit-unavailable.
"""

import logging
import os
import time
import uuid

import boto3
from shared_services.activity_writer import write_activity

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

# Read (don't hard-index) DYNAMODB_TABLE_NAME so merely IMPORTING this module
# never KeyErrors when the var is unset — that import-time crash would defeat the
# agent gate's deliberate `table = ... if TABLE_NAME else None` graceful guard,
# which imports this module. A None table is enforced per-call in create_command.
TABLE_NAME = os.environ.get('DYNAMODB_TABLE_NAME')
WEBSOCKET_ENDPOINT = os.environ.get('WEBSOCKET_ENDPOINT', '')

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME) if TABLE_NAME else None
# Low-level client used for TransactWriteItems (atomic rate-limit + create).
ddb_client = boto3.client('dynamodb')

# Command TTL: 24 hours
COMMAND_TTL_SECONDS = 86400

# Rate limiting: max commands per user per minute
RATE_LIMIT_MAX = int(os.environ.get('COMMAND_RATE_LIMIT_MAX', '10'))
RATE_LIMIT_WINDOW = 60  # seconds


class RateLimitUnavailableError(Exception):
    """Raised when the rate limit check fails due to a backend error (not actual rate limiting)."""


class RateLimitExceededError(Exception):
    """Raised when the rate limit would be exceeded (surfaced as 429 by handler)."""


def _reserve_and_create_command(user_sub, command_id, command_type, payload):
    """Atomically reserve a rate-limit slot and create the pending command record.

    Uses DynamoDB TransactWriteItems so the rate-limit counter increment and the
    command record write either both succeed or both fail. This closes the gap
    where a rate-limit increment could commit without a corresponding command
    record (or vice versa).

    Returns the created command record (dict) on success.

    Raises:
        RateLimitExceededError: rate-limit condition failed; no writes committed.
        RateLimitUnavailableError: DynamoDB call failed for reasons other than
            the rate-limit condition (fail closed).
    """
    from boto3.dynamodb.types import TypeSerializer
    from botocore.exceptions import ClientError

    now = int(time.time())
    # Fixed-window bucket (epoch-aligned). A burst at the boundary can span two
    # buckets and observe up to 2x RATE_LIMIT_MAX — this is an accepted tradeoff
    # for a simple, atomic DynamoDB-backed counter. Do not "fix" by switching
    # windows without also switching to a sliding-window algorithm.
    window_key = now // RATE_LIMIT_WINDOW
    item = {
        'PK': f'COMMAND#{command_id}',
        'SK': '#METADATA',
        'commandId': command_id,
        'cognitoSub': user_sub,
        'type': command_type,
        'payload': payload,
        'status': 'pending',
        'createdAt': now,
        'ttl': now + COMMAND_TTL_SECONDS,
    }

    serializer = TypeSerializer()
    serialized_item = {k: serializer.serialize(v) for k, v in item.items()}

    try:
        ddb_client.transact_write_items(
            TransactItems=[
                {
                    'Update': {
                        'TableName': TABLE_NAME,
                        'Key': {
                            'PK': {'S': f'USER#{user_sub}'},
                            'SK': {'S': f'RATELIMIT#cmd#{window_key}'},
                        },
                        'UpdateExpression': 'ADD #count :inc SET #ttl = if_not_exists(#ttl, :ttl)',
                        'ConditionExpression': 'attribute_not_exists(#count) OR #count < :limit',
                        'ExpressionAttributeNames': {'#count': 'count', '#ttl': 'ttl'},
                        'ExpressionAttributeValues': {
                            ':inc': {'N': '1'},
                            ':ttl': {'N': str(now + RATE_LIMIT_WINDOW + 60)},
                            ':limit': {'N': str(RATE_LIMIT_MAX)},
                        },
                    }
                },
                {
                    'Put': {
                        'TableName': TABLE_NAME,
                        'Item': serialized_item,
                        # Defensive: guarantees idempotency if a retry reuses a uuid.
                        'ConditionExpression': 'attribute_not_exists(PK)',
                    }
                },
            ]
        )
        return item
    except ClientError as e:
        code = e.response.get('Error', {}).get('Code', '')
        if code == 'TransactionCanceledException':
            reasons = e.response.get('CancellationReasons') or []
            # Index 0 = rate-limit update; ConditionalCheckFailed => rate-limited.
            if reasons and reasons[0].get('Code') == 'ConditionalCheckFailed':
                raise RateLimitExceededError() from e
            logger.exception('Command transaction cancelled: %s', reasons)
            raise RateLimitUnavailableError(str(e)) from e
        logger.exception('Command transaction DynamoDB error')
        raise RateLimitUnavailableError(str(e)) from e
    except RateLimitExceededError:
        raise
    except Exception as e:
        logger.exception('Command transaction error')
        raise RateLimitUnavailableError(str(e)) from e


def create_command(user_sub: str, command_type: str, payload: dict) -> tuple[int, dict]:
    """Create a command record and dispatch it to the user's Electron agent.

    Community-clean, agent- and quota-agnostic (ADR-009). Callers reserve quota
    (if any) BEFORE calling this; this function knows nothing about quota.

    Returns ``(status_code, body_dict)`` — the same shape ``command-dispatch``
    returns over ``POST /commands``:

    - 200 ``{'commandId', 'status': 'dispatched'}`` — created + dispatched.
    - 409 ``{'error': 'No agent connected'}`` — no agent connection (no quota burned).
    - 429 rate-limited — the per-user command rate limit was hit.
    - 503 ``{'error': 'Agent disconnected', ...}`` — the agent connection vanished
      mid-send, the agent-connection lookup failed, or the rate-limit check was
      unavailable (all fail closed, all strictly BEFORE any real send).

    Every RETURNED status is a clean, definitely-not-sent outcome. A post-send
    exception (status update / browser notify / activity write) instead PROPAGATES
    deliberately: it is the ambiguous-outcome signal the agent gate relies on (a
    real send may already have happened, so callers must not revert). Because the
    only clean-not-sent failure that could precede the dispatch — the agent-connection
    lookup — is caught and returned as 503, the RAISE channel is exclusively at/after
    the WebSocket dispatch, i.e. always maybe-sent.
    """
    # A misconfigured deploy (no DYNAMODB_TABLE_NAME) surfaces a clear config
    # error rather than an opaque NoneType AttributeError deeper in the send path,
    # mirroring the SFN handlers' `table is None` guard.
    if table is None:
        raise RuntimeError('DYNAMODB_TABLE_NAME not configured')

    from shared_services.websocket_service import WebSocketService

    ws_service = WebSocketService(table, WEBSOCKET_ENDPOINT)

    # Look up user's agent connection before reserving a rate-limit slot, so
    # we don't consume quota on guaranteed-409s. A lookup FAILURE here is strictly
    # pre-dispatch (nothing has been sent), so return a clean, definitely-not-sent
    # 503 rather than raising — this keeps the raise channel exclusively at/after
    # the WebSocket dispatch below (an ambiguous, maybe-sent outcome), so a caller
    # can treat any raised create_command as "a real send may have happened".
    try:
        agent_conns = ws_service.get_user_connections(user_sub, 'agent')
    except Exception:
        logger.exception('Agent-connection lookup failed for %s; failing closed (not sent)', user_sub)
        return 503, {
            'error': 'Agent lookup unavailable. Please try again.',
            'code': 'AGENT_LOOKUP_UNAVAILABLE',
        }
    if not agent_conns:
        return 409, {'error': 'No agent connected'}

    agent_conn = agent_conns[0]
    command_id = str(uuid.uuid4())

    # Atomically reserve a rate-limit slot AND persist the pending command record.
    # TransactWriteItems guarantees the two writes commit together or not at all,
    # so we can never burn a rate-limit increment without a corresponding record
    # (or vice versa).
    try:
        _reserve_and_create_command(user_sub, command_id, command_type, payload)
    except RateLimitExceededError:
        return 429, {
            'error': 'Too many commands. Please wait before sending more.',
            'code': 'RATE_LIMITED',
            'retryAfter': RATE_LIMIT_WINDOW,
        }
    except RateLimitUnavailableError:
        return 503, {
            'error': 'Rate limit check unavailable. Please try again.',
            'code': 'RATE_LIMIT_UNAVAILABLE',
        }

    # Dispatch to agent
    sent = ws_service.send_to_connection(
        agent_conn['connectionId'],
        {
            'action': 'execute',
            'commandId': command_id,
            'type': command_type,
            'payload': payload,
        },
    )

    if not sent:
        # Agent connection is gone — mark failed and tell client immediately
        table.update_item(
            Key={'PK': f'COMMAND#{command_id}', 'SK': '#METADATA'},
            UpdateExpression='SET #s = :s',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={':s': 'failed'},
        )
        return 503, {
            'error': 'Agent disconnected',
            'commandId': command_id,
            'status': 'failed',
        }

    # Update status to dispatched
    table.update_item(
        Key={'PK': f'COMMAND#{command_id}', 'SK': '#METADATA'},
        UpdateExpression='SET #s = :s',
        ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={':s': 'dispatched'},
    )

    # Notify browser if connected
    browser_conns = ws_service.get_user_connections(user_sub, 'browser')
    for bc in browser_conns:
        ws_service.send_to_connection(
            bc['connectionId'],
            {
                'action': 'command_queued',
                'commandId': command_id,
            },
        )

    write_activity(table, user_sub, 'command_dispatched', metadata={'commandType': command_type})

    return 200, {'commandId': command_id, 'status': 'dispatched'}
