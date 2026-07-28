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

from shared_services.activity_writer import write_activity
from shared_services.aws_clients import dynamodb_client, dynamodb_resource

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

# Read (don't hard-index) DYNAMODB_TABLE_NAME so merely IMPORTING this module
# never KeyErrors when the var is unset — that import-time crash would defeat the
# agent gate's deliberate `table = ... if TABLE_NAME else None` graceful guard,
# which imports this module. A None table is enforced per-call in create_command.
TABLE_NAME = os.environ.get('DYNAMODB_TABLE_NAME')
WEBSOCKET_ENDPOINT = os.environ.get('WEBSOCKET_ENDPOINT', '')

dynamodb = dynamodb_resource()
table = dynamodb.Table(TABLE_NAME) if TABLE_NAME else None
# Low-level client used for TransactWriteItems (atomic rate-limit + create).
# Shares the resource's explicit timeouts: this backs the claim-before-send
# transaction, and CommandDispatchFunction has the smallest Timeout of any
# DynamoDB caller (10s), so botocore's 60s default read timeout meant a hung
# call was a hard Lambda kill instead of a catchable, retryable error.
ddb_client = dynamodb_client()

# Command TTL: 24 hours
COMMAND_TTL_SECONDS = 86400

# The routable command vocabulary, mirroring the ROUTES map in
# client/src/transport/commandRouter.ts — the client router is the authority on
# what is routable, and anything absent from it is answered with
# UNKNOWN_COMMAND after the backend has already written, rate-limited and
# dispatched it. The vocabulary lives here rather than in a gate because it is a
# community concept (ADR-009); the *gated* subset stays in
# linkedin-action-gate's LI_ACTION_COMMAND_TYPES, where it belongs.
#
# Deliberately not generated. The vocabulary is hand-mirrored across six sites
# that express genuinely different subsets (gated-only, dispatchable, routable,
# agent-mappable), so collapsing them into one generated list would lose that
# distinction; a CI drift check over the six sites is the intended guard.
#
# The community edition's router carries only the five browser routes
# (client/src/domains/github is sync-excluded, and the two Comment Concierge
# routes are pro), so this set is a superset there. That is harmless — an
# unroutable-but-known type still gets the client's UNKNOWN_COMMAND — and it
# keeps one vocabulary for both editions.
KNOWN_COMMAND_TYPES = frozenset(
    {
        'linkedin:search',
        'linkedin:send-message',
        'linkedin:add-connection',
        'linkedin:follow-profile',
        'linkedin:profile-init',
        'linkedin:post-comment',
        'linkedin:scrape-feed',
        'github:connect',
        'github:disconnect',
        'github:poll-metrics',
        'github:get-status',
    }
)

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
    - 400 ``{'error': ..., 'code': 'UNKNOWN_COMMAND_TYPE'}`` — the type is not in
      :data:`KNOWN_COMMAND_TYPES` (checked first; nothing is read or written).
    - 409 ``{'error': 'No agent connected'}`` — no agent connection (no quota burned).
    - 429 rate-limited — the per-user command rate limit was hit.
    - 503 ``{'error': 'Agent disconnected', ...}`` — the agent connection vanished
      mid-send, the agent-connection lookup failed, or the rate-limit check was
      unavailable (all fail closed, all strictly BEFORE any real send).

    Every RETURNED status is a clean, definitely-not-sent outcome. A post-send
    exception on work that MATTERS — currently just the ``dispatched`` status
    write — instead PROPAGATES deliberately: it is the ambiguous-outcome signal
    the agent gate relies on (a real send may already have happened, so callers
    must not revert). Because the only clean-not-sent failure that could precede
    the dispatch — the agent-connection lookup — is caught and returned as 503,
    the RAISE channel is exclusively at/after the WebSocket dispatch, i.e. always
    maybe-sent.

    Cosmetic post-send work — the browser notification and the activity write —
    is explicitly NOT on that channel. Both are side channels that re-establish
    themselves (the browser re-polls; activity is a timeline record), so failing
    a completed LinkedIn action on one of them would report a success as a
    failure. Each is wrapped and logged at its call site with the reason.
    """
    # Vocabulary check FIRST: it needs no table, no lookup and no rate-limit
    # slot, and it must not be able to reach the RAISE channel below — a caller
    # reads any raised create_command as "a real send may have happened", so a
    # typo hitting a misconfigured deploy would be treated as an ambiguous send
    # and refused a quota refund. A RETURNED 400 is the honest answer: nothing
    # was sent, and nothing could have been.
    if command_type not in KNOWN_COMMAND_TYPES:
        logger.warning('Rejecting unknown command type %r for %s', command_type, user_sub)
        return 400, {
            'error': f'Unknown command type: {command_type}',
            'code': 'UNKNOWN_COMMAND_TYPE',
        }

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

    # Notify browser if connected. Best-effort, and deliberately OFF the raise
    # channel: the send already happened and the COMMAND# already says
    # 'dispatched', so this is a UI nicety, not a correctness input. It used to
    # be able to fail the whole call — send_to_connection re-raises every
    # ClientError except GoneException, so a @connections throttle
    # (LimitExceededException) or an oversized frame (PayloadTooLargeException)
    # on a *browser notification* propagated out of create_command, which the
    # gate reads as maybe-sent and turns into a 503. A LinkedIn action that
    # fully succeeded was reported to the user as a failure.
    #
    # Consistency is re-established without this: the browser polls the command
    # status, and a stale WSCONN# is reaped by the next send's GoneException.
    # The lookup is inside the try too — it is the same DynamoDB query that can
    # throttle, and it is just as cosmetic.
    try:
        browser_conns = ws_service.get_user_connections(user_sub, 'browser')
        for bc in browser_conns:
            ws_service.send_to_connection(
                bc['connectionId'],
                {
                    'action': 'command_queued',
                    'commandId': command_id,
                },
            )
    except Exception:
        logger.exception(
            'Browser notify failed after a successful dispatch of %s; the command stands and the browser re-polls',
            command_id,
        )

    # Same reasoning: the activity timeline is a record of what happened, not an
    # input to whether it happened. write_activity is already documented as
    # fire-and-forget, but it can still raise on a client construction error
    # before its own internal guard, so keep it off the raise channel here.
    try:
        write_activity(table, user_sub, 'command_dispatched', metadata={'commandType': command_type})
    except Exception:
        logger.exception('Activity write failed after a successful dispatch of %s; the command stands', command_id)

    return 200, {'commandId': command_id, 'status': 'dispatched'}
