"""LinkedIn action gate — meters user-initiated LinkedIn actions.

The manual counterpart to the agent's ``agent-action-task/gate_dispatch``: it
reserves the shared ``li-actions`` quota bucket before a user-initiated
connect / message / follow, then creates the command by calling the
community-clean ``command_dispatch_core`` **in-process** (ADR-009 — no
pro/agent/quota logic is ever added to that core; quota reservation stays here in
the gate). Because the agent and the UI both funnel into the same core but each
reserves exactly once (the agent in gate_dispatch, the UI here), a real LinkedIn
action is never double-metered.

Over the daily/monthly li-actions cap → 429; a metering-infra failure → 503
(fail closed). Metering is a no-op in the community edition, where the injected
``QuotaService`` is a stub, so this is a thin passthrough there.

The request body accepts an optional ``idempotencyKey``. It is claimed with a
conditional ``IDEM#`` write before the reservation, so a retry of a request that
already dispatched — including the retry the ambiguous 503 explicitly invites —
replays the recorded outcome instead of sending a duplicate connect, message or
follow. It is optional because this endpoint is public API surface in the
community edition too.
"""

import hashlib
import json
import logging
import os
import time

from botocore.exceptions import ClientError
from errors.exceptions import NotFoundError, QuotaExceededError
from shared_services.aws_clients import dynamodb_resource
from shared_services.command_dispatch_core import create_command
from shared_services.legal_acceptance_service import (
    AcceptanceRequiredError,
    require_automation_acceptance,
)
from shared_services.monetization import QuotaService, ensure_tier_exists
from shared_services.observability import setup_correlation_context
from shared_services.request_utils import api_response, extract_user_id

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

TABLE_NAME = os.environ['DYNAMODB_TABLE_NAME']

table = dynamodb_resource().Table(TABLE_NAME)
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


# A FROZEN outcome expires with the COMMAND# record it guards
# (command_dispatch_core.COMMAND_TTL_SECONDS), so the two disappear together.
IDEMPOTENCY_TTL_SECONDS = 86400

# An UNFINISHED claim gets a short lease instead. The two states need different
# lifetimes: a frozen outcome must outlive every plausible retry, but a claim
# with no outcome means the request died between claiming and recording — a
# Lambda timeout or kill, which no `except` can catch — and giving that the full
# 24 hours locked the caller out of one exact action for a day over a send that
# never happened. The lease is comfortably longer than the function's own
# timeout, so it cannot expire under a request that is still running.
IDEMPOTENCY_LEASE_SECONDS = 900

MAX_IDEMPOTENCY_KEY_LENGTH = 200


def _idem_key(user_id: str, key: str) -> dict[str, str]:
    return {'PK': f'USER#{user_id}', 'SK': f'IDEM#{key}'}


def _request_fingerprint(command_type: str, payload) -> str:
    """Stable hash of the request a key was claimed for.

    The marker is keyed only by user and key, so nothing tied a replayed outcome
    to the request that produced it. A caller reusing one key for a different
    action — a client bug, or a second tab — got back the FIRST request's frozen
    response as though it were its own. Our own frontend derives the key from
    `type + JSON.stringify(payload)` so it cannot collide, but the gate must not
    depend on a client behaving.
    """
    canonical = json.dumps({'type': command_type, 'payload': payload}, sort_keys=True, default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()


def _claim_idempotency_key(user_id: str, key: str, fingerprint: str) -> dict | None:
    """Claim ``key`` for this attempt.

    Returns ``None`` when the claim succeeded — this is the first attempt for
    that key. Returns the existing marker (possibly empty) when the conditional
    write lost, i.e. the request was already accepted. Any other DynamoDB error
    propagates: the caller fails closed rather than sending unguarded.
    """
    now = int(time.time())
    try:
        table.put_item(
            Item={
                **_idem_key(user_id, key),
                'startedAt': now,
                'fingerprint': fingerprint,
                # Short lease, extended to the full TTL only when an outcome is
                # frozen. See IDEMPOTENCY_LEASE_SECONDS.
                'ttl': now + IDEMPOTENCY_LEASE_SECONDS,
            },
            # An EXPIRED lease is claimable, not just an absent item. With
            # `attribute_not_exists(PK)` alone, a claim abandoned between the
            # write and the freeze (a crash, a timeout) stayed unclaimable until
            # DynamoDB physically deleted the row — and TTL deletion is only
            # "typically within 48 hours", with no upper bound. That made
            # IDEMPOTENCY_LEASE_SECONDS aspirational: the value said 15 minutes
            # while the real reclaim window was up to two days. Comparing the
            # stored ttl to now enforces the lease we actually documented.
            ConditionExpression='attribute_not_exists(PK) OR #ttl < :now',
            ExpressionAttributeNames={'#ttl': 'ttl'},
            ExpressionAttributeValues={':now': now},
        )
        return None
    except ClientError as e:
        if e.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
            raise
        return table.get_item(Key=_idem_key(user_id, key)).get('Item') or {}


def _freeze_idempotent_outcome(user_id: str, key: str, status_code: int, body_obj) -> None:
    """Record an outcome that must NOT be repeated, so a retry replays it.

    Only two outcomes get frozen: a dispatched send, and the ambiguous
    post-dispatch 503 — the one the "please retry" message invites the user to
    repeat. Best effort: failing here costs a duplicate-send window on a retry,
    but must never fail an action that already dispatched.

    The body is stored as a JSON STRING rather than a map. DynamoDB round-trips
    numbers as ``Decimal`` and ``api_response`` serializes with ``default=str``,
    so a map-stored body would replay ``60`` as ``"60"`` — a replay that is not
    the outcome it claims to be.
    """
    try:
        now = int(time.time())
        table.update_item(
            Key=_idem_key(user_id, key),
            # #ttl is promoted from the short claim lease to the full TTL here:
            # this marker now carries an outcome that must outlive every
            # plausible retry, which is exactly what the lease is not for.
            UpdateExpression=('SET outcomeStatus = :s, outcomeBody = :b, completedAt = :t, #ttl = :ttl'),
            ExpressionAttributeNames={'#ttl': 'ttl'},
            ExpressionAttributeValues={
                ':s': status_code,
                ':b': json.dumps(body_obj, default=str),
                ':t': now,
                ':ttl': now + IDEMPOTENCY_TTL_SECONDS,
            },
        )
    except Exception:
        logger.exception('Failed to record idempotent outcome for %s; a retry may re-dispatch', key)


def _release_idempotency_key(user_id: str, key: str) -> None:
    """Drop the marker after a definitely-not-sent outcome. Never raises.

    Freezing these would be wrong: nothing was sent, the reservation was already
    refunded, and replaying (say) a transient "no agent connected" for 24h would
    strand the user on a failure a retry legitimately fixes. The key exists to
    stop a duplicate SEND, not to make every attempt single-shot.
    """
    try:
        table.delete_item(Key=_idem_key(user_id, key))
    except Exception:
        logger.exception('Failed to release idempotency marker %s; retries with it will 409 until its TTL', key)


def _release(user_id: str, command_type: str) -> None:
    """Best-effort refund of a prior li-actions reservation. Never raises."""
    try:
        _quota_service.release_li_action_usage(user_id, command_type)
    except Exception:
        logger.exception('release_li_action_usage failed for %s', command_type)


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

    # Optional idempotency key. Optional rather than required because
    # /linkedin-actions is public API surface in the community edition too, so
    # mandating it would break every existing caller. Validated up front: an
    # unbounded or non-string value would become part of a DynamoDB sort key.
    idempotency_key = body.get('idempotencyKey')
    if idempotency_key is not None and (
        not isinstance(idempotency_key, str) or not idempotency_key or len(idempotency_key) > MAX_IDEMPOTENCY_KEY_LENGTH
    ):
        return api_response(
            400,
            {
                'error': f'idempotencyKey must be a non-empty string of at most {MAX_IDEMPOTENCY_KEY_LENGTH} characters',
                'code': 'INVALID_IDEMPOTENCY_KEY',
            },
            event,
            allowed_methods=_ALLOWED_METHODS,
        )

    # Best-effort tier auto-provision so a brand-new user's first action isn't
    # denied for a missing tier row (recoverable on a later call; never blocks).
    try:
        ensure_tier_exists(table, user_id)
    except Exception:
        logger.exception('Tier auto-provision failed for %s (non-blocking)', command_type)

    # The LinkedIn risk disclosure gates automation, and it is enforced here
    # rather than only in the UI: a client that never renders the modal must
    # still be unable to dispatch a real LinkedIn action.
    try:
        require_automation_acceptance(table, user_id)
    except AcceptanceRequiredError as e:
        return api_response(
            403,
            {
                'error': 'You must review and accept the LinkedIn automation risk disclosure before using automation.',
                'code': 'LEGAL_ACCEPTANCE_REQUIRED',
                'documentId': e.document_id,
                'version': e.version,
            },
            event,
            allowed_methods=_ALLOWED_METHODS,
        )

    # Claim the key BEFORE the reservation, so a retry cannot double-meter either.
    if idempotency_key:
        fingerprint = _request_fingerprint(command_type, body.get('payload', {}))
        try:
            existing = _claim_idempotency_key(user_id, idempotency_key, fingerprint)
        except Exception:
            # Fail closed, matching the metering rule: never a silent unguarded send.
            logger.exception('Idempotency claim failed for %s, denying request (fail closed)', command_type)
            return api_response(
                503,
                {'error': 'Idempotency store unavailable, please retry', 'code': 'IDEMPOTENCY_UNAVAILABLE'},
                event,
                allowed_methods=_ALLOWED_METHODS,
            )
        if existing is not None:
            # A key belongs to the request that claimed it. Replaying one
            # request's outcome for a different action would be worse than any
            # error: the caller is told its send succeeded when what actually
            # went out was something else entirely. Markers written before this
            # field existed carry no fingerprint and are trusted, so the check
            # cannot break requests already in flight during a deploy.
            recorded = existing.get('fingerprint')
            if recorded and recorded != fingerprint:
                logger.warning('Idempotency key %s reused for a different request', idempotency_key)
                return api_response(
                    422,
                    {
                        'error': (
                            'This idempotency key was already used for a different action. '
                            'Use a new key, or resend the original request unchanged.'
                        ),
                        'code': 'IDEMPOTENCY_KEY_REUSED',
                    },
                    event,
                    allowed_methods=_ALLOWED_METHODS,
                )
            if 'outcomeStatus' in existing:
                # The original finished on an outcome that must not be repeated.
                # outcomeBody is a JSON string, written with outcomeStatus in one
                # update — see _freeze_idempotent_outcome for why it is not a map.
                return api_response(
                    int(existing['outcomeStatus']),
                    json.loads(existing['outcomeBody']),
                    event,
                    allowed_methods=_ALLOWED_METHODS,
                )
            # Still in flight. 409 is unambiguous and, unlike a second dispatch,
            # cannot double-send.
            return api_response(
                409,
                {
                    'error': 'A request with this idempotency key is already in progress',
                    'code': 'REQUEST_IN_PROGRESS',
                },
                event,
                allowed_methods=_ALLOWED_METHODS,
            )

    # Reserve the shared li-actions bucket BEFORE dispatching (enforcing). No-op
    # in the community edition (stub QuotaService).
    try:
        _quota_service.reserve_li_action_usage(user_id, command_type)
    except QuotaExceededError:
        if idempotency_key:
            _release_idempotency_key(user_id, idempotency_key)
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
        if idempotency_key:
            _release_idempotency_key(user_id, idempotency_key)
        return api_response(
            503,
            {'error': 'Quota service unavailable, please retry', 'code': 'QUOTA_UNAVAILABLE'},
            event,
            allowed_methods=_ALLOWED_METHODS,
        )
    except Exception:
        # Nothing has dispatched yet, so this is unambiguously not-sent and the
        # marker MUST be released — otherwise the caller is locked out of this
        # exact action for the full IDEMPOTENCY_TTL_SECONDS.
        #
        # This branch is not theoretical. aws_clients.dynamodb_resource() sets an
        # explicit read_timeout, so a slow table raises botocore's
        # ReadTimeoutError/ConnectTimeoutError — subclasses of BotoCoreError, NOT
        # of ClientError. Those escaped the two handlers above, left the claim
        # written with no outcomeStatus, and every retry then took the
        # REQUEST_IN_PROGRESS branch for 24 hours over a send that never happened.
        # Enumerating exception types is what created that hole; the release has
        # to be driven by the position in the flow, not by the exception class.
        logger.exception(
            'reserve_li_action_usage raised an unexpected error for %s, denying request (fail closed)',
            command_type,
        )
        if idempotency_key:
            _release_idempotency_key(user_id, idempotency_key)
        return api_response(
            503,
            {'error': 'Quota service unavailable, please retry', 'code': 'QUOTA_UNAVAILABLE'},
            event,
            allowed_methods=_ALLOWED_METHODS,
        )

    # Create the command by calling the community-clean core in-process (ADR-009).
    # Every clean, definitely-not-sent outcome is RETURNED as a status code (409 no
    # agent / 429 rate-limited / 503 agent-lookup-or-disconnect) and refunds via the
    # status_code != 200 branch below. A RAISED create_command is therefore now
    # exclusively an at/after-WebSocket-dispatch (maybe-sent) failure.
    try:
        status_code, body_obj = create_command(user_id, command_type, body.get('payload', {}))
    except Exception:
        # A real LinkedIn send may already have dispatched over WebSocket before this
        # exception, so we must NOT refund — keeping the reservation stops a dispatched
        # action from escaping the daily cap. Fail closed with 503; the clean,
        # definitely-not-sent cases still refund via the status_code != 200 branch.
        logger.exception('command creation failed post-dispatch for %s; keeping reservation', command_type)
        # The message must describe what actually happens next. "Please retry"
        # was false: the freeze below makes every retry with this key replay
        # THIS response without dispatching, so a user following that
        # instruction could never succeed and had no way to tell why. Blocking
        # the re-send is correct — the action may already have gone out — but it
        # has to be said plainly, and the caller needs a code it can branch on
        # rather than prose it has to match.
        ambiguous = {
            'error': (
                'The action was dispatched but its outcome could not be recorded. '
                'It may already have been performed — check LinkedIn before trying again. '
                'Repeating it with the same details will replay this result rather than send again.'
            ),
            'code': 'DISPATCH_OUTCOME_UNKNOWN',
        }
        # Freeze it so the retry cannot become the duplicate send the key exists
        # to prevent. The key makes the RETRY safe; it does not make the original
        # outcome knowable, so the no-refund decision above is unchanged.
        if idempotency_key:
            _freeze_idempotent_outcome(user_id, idempotency_key, 503, ambiguous)
        return api_response(503, ambiguous, event, allowed_methods=_ALLOWED_METHODS)

    # The core did not accept the send (rate-limited, agent offline, etc.) — refund
    # so an un-dispatched action doesn't burn the daily cap. (A 200 means dispatched
    # to the agent; an action that later fails on-device still counts, mirroring the
    # agent gate's dispatch-time metering.)
    if status_code != 200:
        _release(user_id, command_type)

    if idempotency_key:
        if status_code == 200:
            _freeze_idempotent_outcome(user_id, idempotency_key, status_code, body_obj)
        else:
            # Definitely not sent and already refunded, so the same key stays
            # usable — see _release_idempotency_key.
            _release_idempotency_key(user_id, idempotency_key)

    # Re-emit through api_response so CORS headers match the /linkedin-actions route.
    return api_response(status_code, body_obj, event, allowed_methods=_ALLOWED_METHODS)
