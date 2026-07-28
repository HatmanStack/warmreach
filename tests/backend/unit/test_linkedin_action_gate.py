"""Unit tests for the LinkedIn action gate (manual li-actions metering).

The gate now creates the command by calling ``command_dispatch_core.create_command``
IN-PROCESS (no Lambda hop), so these tests patch that function on the gate module
and re-assert the send-path invariants: reserve-before-create, fail-closed metering
(429 over quota / 503 on metering-infra failure), refund on a non-200 create (a
clean, definitely-not-sent outcome) but NOT on a raised create (maybe-sent — a real
send may already have dispatched), and the non-object-body guard.
"""

import json
from unittest.mock import MagicMock, patch

import pytest
from conftest import load_lambda_module


@pytest.fixture
def gate_module():
    """Load the gate with the quota service and the in-process create_command mocked."""
    module = load_lambda_module("linkedin-action-gate")
    module._quota_service = MagicMock()
    module.create_command = MagicMock(
        return_value=(200, {"commandId": "cmd-1", "status": "dispatched"})
    )
    # These tests cover quota reservation and dispatch. The LinkedIn risk
    # disclosure gate sits ahead of both and would 403 every one of them, so it
    # is stubbed satisfied here — its own enforcement is covered directly in
    # test_legal_acceptance_service.py, including that a client which skips the
    # modal still cannot dispatch.
    module.require_automation_acceptance = MagicMock(return_value=None)
    return module


def _event(command_type="linkedin:add-connection", payload=None, sub="user-1"):
    ctx = {"http": {"method": "POST"}}
    if sub:
        ctx["authorizer"] = {"jwt": {"claims": {"sub": sub}}}
    return {
        "httpMethod": "POST",
        "rawPath": "/linkedin-actions",
        "requestContext": ctx,
        "body": json.dumps({"type": command_type, "payload": payload or {}}),
    }


def _dispatch_returns(gate_module, status_code=200, body=None):
    """Make the mocked in-process create_command return a (status, body) tuple."""
    gate_module.create_command.return_value = (
        status_code,
        body or {"commandId": "cmd-1", "status": "dispatched"},
    )


def test_gates_and_forwards_on_success(gate_module, lambda_context):
    _dispatch_returns(gate_module, 200, {"commandId": "cmd-1", "status": "dispatched"})
    resp = gate_module.lambda_handler(_event(), lambda_context)
    assert resp["statusCode"] == 200
    gate_module._quota_service.reserve_li_action_usage.assert_called_once()
    gate_module.create_command.assert_called_once()
    gate_module._quota_service.release_li_action_usage.assert_not_called()
    assert json.loads(resp["body"])["commandId"] == "cmd-1"


def test_reserve_precedes_create(gate_module, lambda_context):
    """Quota is reserved BEFORE the command is created (claim-before-send)."""
    order = []
    gate_module._quota_service.reserve_li_action_usage.side_effect = lambda *a, **k: (
        order.append("reserve")
    )
    gate_module.create_command.side_effect = lambda *a, **k: (
        order.append("create"),
        (200, {"commandId": "c"}),
    )[1]
    gate_module.lambda_handler(_event(), lambda_context)
    assert order == ["reserve", "create"]


def test_create_passes_type_and_payload(gate_module, lambda_context):
    """The gate forwards the validated command type and payload to the core."""
    gate_module.lambda_handler(
        _event(command_type="linkedin:send-message", payload={"x": 1}), lambda_context
    )
    args = gate_module.create_command.call_args[0]
    assert args[0] == "user-1"
    assert args[1] == "linkedin:send-message"
    assert args[2] == {"x": 1}


def test_over_quota_returns_429_without_dispatch(gate_module, lambda_context):
    from errors.exceptions import QuotaExceededError

    gate_module._quota_service.reserve_li_action_usage.side_effect = QuotaExceededError(
        "cap", operation="linkedin:add-connection"
    )
    resp = gate_module.lambda_handler(_event(), lambda_context)
    assert resp["statusCode"] == 429
    gate_module.create_command.assert_not_called()


def test_reserve_infra_failure_fails_closed_503(gate_module, lambda_context):
    from botocore.exceptions import ClientError

    gate_module._quota_service.reserve_li_action_usage.side_effect = ClientError(
        {"Error": {"Code": "ProvisionedThroughputExceededException"}}, "UpdateItem"
    )
    resp = gate_module.lambda_handler(_event(), lambda_context)
    assert resp["statusCode"] == 503
    gate_module.create_command.assert_not_called()


def test_unsupported_type_400_no_reserve(gate_module, lambda_context):
    # A read op (search) must never consume the li-actions bucket.
    resp = gate_module.lambda_handler(
        _event(command_type="linkedin:search"), lambda_context
    )
    assert resp["statusCode"] == 400
    gate_module._quota_service.reserve_li_action_usage.assert_not_called()
    gate_module.create_command.assert_not_called()


def test_dispatch_failure_refunds_quota(gate_module, lambda_context):
    # create_command returns 409 (no agent) -> refund and pass 409 through.
    _dispatch_returns(gate_module, 409, {"error": "No agent connected"})
    resp = gate_module.lambda_handler(_event(), lambda_context)
    assert resp["statusCode"] == 409
    gate_module._quota_service.release_li_action_usage.assert_called_once()


def test_create_command_raises_keeps_reservation_and_503(gate_module, lambda_context):
    """A RAISED create_command is now exclusively an at/after-dispatch (maybe-sent)
    outcome: the core turns its only clean pre-dispatch failure (the agent-connection
    lookup) into a RETURNED 503. A real LinkedIn send may already have dispatched, so
    the gate must NOT refund — it keeps the reservation and fails closed with 503."""
    gate_module.create_command.side_effect = RuntimeError("post-send boom")
    resp = gate_module.lambda_handler(_event(), lambda_context)
    assert resp["statusCode"] == 503
    gate_module._quota_service.release_li_action_usage.assert_not_called()


def test_unauthenticated_returns_401(gate_module, lambda_context):
    resp = gate_module.lambda_handler(_event(sub=None), lambda_context)
    assert resp["statusCode"] == 401
    gate_module._quota_service.reserve_li_action_usage.assert_not_called()


def test_non_object_json_body_returns_400(gate_module, lambda_context):
    # A valid-JSON scalar/array must not crash the handler (AttributeError -> 500).
    event = _event()
    event["body"] = json.dumps(["not", "an", "object"])
    resp = gate_module.lambda_handler(event, lambda_context)
    assert resp["statusCode"] == 400
    gate_module._quota_service.reserve_li_action_usage.assert_not_called()
    gate_module.create_command.assert_not_called()


def test_options_preflight_returns_204(gate_module, lambda_context):
    event = _event()
    event["httpMethod"] = "OPTIONS"
    event["requestContext"]["http"]["method"] = "OPTIONS"
    resp = gate_module.lambda_handler(event, lambda_context)
    assert resp["statusCode"] == 204
    gate_module._quota_service.reserve_li_action_usage.assert_not_called()
    gate_module.create_command.assert_not_called()


def test_command_dispatch_rate_limited_passes_through_and_refunds(
    gate_module, lambda_context
):
    # The core's own 10/min rate limit (429) -> refund + pass 429 through.
    _dispatch_returns(
        gate_module, 429, {"error": "Too many commands", "code": "RATE_LIMITED"}
    )
    resp = gate_module.lambda_handler(_event(), lambda_context)
    assert resp["statusCode"] == 429
    gate_module._quota_service.release_li_action_usage.assert_called_once()


# --- Idempotency key (health audit HIGH #9) -----------------------------------
# The maybe-sent path correctly refuses to refund quota and returns 503 "please
# retry", but the endpoint accepted no idempotency key, so a user acting on that
# message sent a duplicate connect / message / follow. These tests use a real
# moto table because the marker is a conditional write, which is the whole
# mechanism.


@pytest.fixture
def gate_with_table(dynamodb_table):
    module = load_lambda_module("linkedin-action-gate")
    module.table = dynamodb_table
    module._quota_service = MagicMock()
    module.create_command = MagicMock(
        return_value=(200, {"commandId": "cmd-1", "status": "dispatched"})
    )
    module.require_automation_acceptance = MagicMock(return_value=None)
    module.ensure_tier_exists = MagicMock(return_value=None)
    return module


def _idem_event(
    key, command_type="linkedin:add-connection", payload=None, sub="user-1"
):
    event = _event(command_type=command_type, payload=payload, sub=sub)
    body = json.loads(event["body"])
    body["idempotencyKey"] = key
    event["body"] = json.dumps(body)
    return event


def _marker(module, key, sub="user-1"):
    return module.table.get_item(Key={"PK": f"USER#{sub}", "SK": f"IDEM#{key}"}).get(
        "Item"
    )


def test_a_repeat_request_replays_the_outcome_instead_of_dispatching_again(
    gate_with_table, lambda_context
):
    first = gate_with_table.lambda_handler(_idem_event("key-1"), lambda_context)
    second = gate_with_table.lambda_handler(_idem_event("key-1"), lambda_context)

    assert first["statusCode"] == 200
    assert second["statusCode"] == first["statusCode"]
    assert json.loads(second["body"]) == json.loads(first["body"])
    # One dispatch, one reservation — the whole point.
    assert gate_with_table.create_command.call_count == 1
    assert gate_with_table._quota_service.reserve_li_action_usage.call_count == 1


def test_a_second_request_while_the_first_is_in_flight_returns_409(
    gate_with_table, lambda_context
):
    """No outcome recorded yet means the original has not finished. 409 is
    unambiguous and, unlike a duplicate dispatch, cannot double-send."""
    gate_with_table.table.put_item(
        Item={"PK": "USER#user-1", "SK": "IDEM#key-inflight", "startedAt": 1}
    )

    resp = gate_with_table.lambda_handler(_idem_event("key-inflight"), lambda_context)

    assert resp["statusCode"] == 409
    assert json.loads(resp["body"])["code"] == "REQUEST_IN_PROGRESS"
    gate_with_table.create_command.assert_not_called()
    gate_with_table._quota_service.reserve_li_action_usage.assert_not_called()


def test_without_a_key_the_endpoint_behaves_exactly_as_before(
    gate_with_table, lambda_context
):
    """The key is optional: /linkedin-actions is public API surface for the
    community edition too, so an existing caller must not change behaviour."""
    gate_with_table.lambda_handler(_event(), lambda_context)
    gate_with_table.lambda_handler(_event(), lambda_context)

    assert gate_with_table.create_command.call_count == 2
    assert gate_with_table._quota_service.reserve_li_action_usage.call_count == 2
    assert gate_with_table.table.scan()["Count"] == 0


def test_the_marker_is_claimed_before_quota_is_reserved(
    gate_with_table, lambda_context
):
    """A retry must not be able to double-meter either."""
    order = []
    real_put = gate_with_table.table.put_item

    def _put(**kwargs):
        if str(kwargs.get("Item", {}).get("SK", "")).startswith("IDEM#"):
            order.append("claim")
        return real_put(**kwargs)

    gate_with_table._quota_service.reserve_li_action_usage.side_effect = (
        lambda *a, **k: order.append("reserve")
    )
    with patch.object(gate_with_table.table, "put_item", side_effect=_put):
        gate_with_table.lambda_handler(_idem_event("key-order"), lambda_context)

    assert order == ["claim", "reserve"]


def test_a_definitely_not_sent_outcome_frees_the_key_for_a_real_retry(
    gate_with_table, lambda_context
):
    """Nothing was sent and the quota was refunded, so replaying the failure for
    24h would strand the user on a transient "no agent connected". The marker is
    released instead; only outcomes that must not be repeated are frozen."""
    _dispatch_returns(gate_with_table, 409, {"error": "No agent connected"})
    first = gate_with_table.lambda_handler(_idem_event("key-clean"), lambda_context)
    assert first["statusCode"] == 409
    assert _marker(gate_with_table, "key-clean") is None

    _dispatch_returns(
        gate_with_table, 200, {"commandId": "cmd-2", "status": "dispatched"}
    )
    second = gate_with_table.lambda_handler(_idem_event("key-clean"), lambda_context)
    assert second["statusCode"] == 200
    assert gate_with_table.create_command.call_count == 2


def test_the_ambiguous_503_is_frozen_and_still_keeps_the_reservation(
    gate_with_table, lambda_context
):
    """A raised create_command is maybe-sent. The key makes the RETRY safe; it
    does not make the original outcome knowable, so the no-refund reasoning is
    untouched (Phase-0 §5.2)."""
    gate_with_table.create_command.side_effect = RuntimeError("post-send boom")
    first = gate_with_table.lambda_handler(_idem_event("key-ambiguous"), lambda_context)
    assert first["statusCode"] == 503
    gate_with_table._quota_service.release_li_action_usage.assert_not_called()

    second = gate_with_table.lambda_handler(
        _idem_event("key-ambiguous"), lambda_context
    )
    assert second["statusCode"] == 503
    assert json.loads(second["body"]) == json.loads(first["body"])
    # The retry the 503 message invites cannot re-dispatch.
    assert gate_with_table.create_command.call_count == 1


def test_over_quota_frees_the_key_and_never_dispatches(gate_with_table, lambda_context):
    from errors.exceptions import QuotaExceededError

    gate_with_table._quota_service.reserve_li_action_usage.side_effect = (
        QuotaExceededError("cap", operation="linkedin:add-connection")
    )
    resp = gate_with_table.lambda_handler(_idem_event("key-quota"), lambda_context)
    assert resp["statusCode"] == 429
    assert _marker(gate_with_table, "key-quota") is None
    gate_with_table.create_command.assert_not_called()


@pytest.mark.parametrize("bad_key", [123, {"a": 1}, "", "x" * 201])
def test_a_malformed_key_is_rejected_before_anything_is_reserved(
    gate_with_table, lambda_context, bad_key
):
    resp = gate_with_table.lambda_handler(_idem_event(bad_key), lambda_context)
    assert resp["statusCode"] == 400
    assert json.loads(resp["body"])["code"] == "INVALID_IDEMPOTENCY_KEY"
    gate_with_table._quota_service.reserve_li_action_usage.assert_not_called()
    gate_with_table.create_command.assert_not_called()


def test_an_idempotency_store_failure_fails_closed_without_dispatching(
    gate_with_table, lambda_context
):
    """Fail closed, matching the metering-infrastructure rule: never a silent
    unguarded send (Phase-0 §5.4)."""
    from botocore.exceptions import ClientError

    err = ClientError(
        {"Error": {"Code": "ProvisionedThroughputExceededException"}}, "PutItem"
    )
    with patch.object(gate_with_table.table, "put_item", side_effect=err):
        resp = gate_with_table.lambda_handler(
            _idem_event("key-store-down"), lambda_context
        )

    assert resp["statusCode"] == 503
    assert json.loads(resp["body"])["code"] == "IDEMPOTENCY_UNAVAILABLE"
    gate_with_table._quota_service.reserve_li_action_usage.assert_not_called()
    gate_with_table.create_command.assert_not_called()


def test_the_marker_carries_a_24h_ttl_matching_the_command_record(
    gate_with_table, lambda_context
):
    import time

    gate_with_table.lambda_handler(_idem_event("key-ttl"), lambda_context)
    item = _marker(gate_with_table, "key-ttl")
    assert item is not None
    assert 86000 < int(item["ttl"]) - int(time.time()) <= 86400


def test_keys_are_scoped_per_user(gate_with_table, lambda_context):
    """USER#{sub} is the partition, so one user's key can never block another's."""
    gate_with_table.lambda_handler(
        _idem_event("shared-key", sub="user-1"), lambda_context
    )
    resp = gate_with_table.lambda_handler(
        _idem_event("shared-key", sub="user-2"), lambda_context
    )
    assert resp["statusCode"] == 200
    assert gate_with_table.create_command.call_count == 2


def test_a_replayed_body_is_byte_identical_to_the_original(
    gate_with_table, lambda_context
):
    """DynamoDB round-trips numbers as Decimal, and api_response serializes with
    ``default=str``, so a body stored as a MAP replays 60 as "60". The whole
    point of the marker is to return the outcome the first attempt returned, so
    the body is stored as a JSON string instead. Today's bodies are strings
    only; this pins the mechanism rather than the current payload."""
    _dispatch_returns(
        gate_with_table, 200, {"commandId": "c1", "retryAfter": 60, "meta": {"n": 3}}
    )
    first = gate_with_table.lambda_handler(_idem_event("key-types"), lambda_context)
    second = gate_with_table.lambda_handler(_idem_event("key-types"), lambda_context)

    assert second["body"] == first["body"]
    assert json.loads(second["body"])["retryAfter"] == 60
    assert json.loads(second["body"])["meta"]["n"] == 3


def test_a_boto_core_error_from_the_reservation_frees_the_key(
    gate_with_table, lambda_context
):
    """A BotoCoreError is not a ClientError.

    aws_clients.dynamodb_resource() sets an explicit read_timeout, so a slow
    table raises ReadTimeoutError — a BotoCoreError subclass. Enumerating
    exception types left it uncaught: the claim stayed written with no
    outcomeStatus and every retry took the REQUEST_IN_PROGRESS branch for the
    full 24h TTL, over a send that never happened.
    """
    from botocore.exceptions import ReadTimeoutError

    gate_with_table._quota_service.reserve_li_action_usage.side_effect = (
        ReadTimeoutError(endpoint_url="https://dynamodb.us-east-1.amazonaws.com")
    )
    resp = gate_with_table.lambda_handler(_idem_event("key-boto"), lambda_context)

    assert resp["statusCode"] == 503
    assert json.loads(resp["body"])["code"] == "QUOTA_UNAVAILABLE"
    gate_with_table.create_command.assert_not_called()
    # The point of the test: the caller is not locked out of this action.
    assert _marker(gate_with_table, "key-boto") is None

    gate_with_table._quota_service.reserve_li_action_usage.side_effect = None
    retry = gate_with_table.lambda_handler(_idem_event("key-boto"), lambda_context)
    assert retry["statusCode"] == 200
    assert gate_with_table.create_command.call_count == 1


def test_the_ambiguous_503_does_not_tell_the_user_to_do_something_futile(
    gate_with_table, lambda_context
):
    """The frozen outcome blocks the re-send, which is correct — the action may
    already have gone out. The defect was the message: it said "please retry"
    while every retry replays this same response without dispatching, so a user
    following the instruction could never succeed and had no way to tell why.
    """
    gate_with_table.create_command.side_effect = RuntimeError("post-send boom")
    resp = gate_with_table.lambda_handler(_idem_event("key-honest"), lambda_context)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 503
    assert body["code"] == "DISPATCH_OUTCOME_UNKNOWN"
    assert "may already have been performed" in body["error"]
    assert "replay this result rather than send again" in body["error"]
    # The old wording is what made it dishonest.
    assert "please retry" not in body["error"].lower()


def test_an_unfinished_claim_gets_a_short_lease_not_the_full_ttl(
    gate_with_table, lambda_context
):
    """A claim with no outcome means the request died between claiming and
    recording — a Lambda timeout or kill, which no `except` can catch. Giving
    that the full 24h locked the caller out of one exact action for a day over a
    send that never happened."""
    gate_with_table.create_command.side_effect = RuntimeError("killed mid-flight")
    gate_with_table._freeze_idempotent_outcome = lambda *a, **k: (
        None
    )  # simulate the kill

    gate_with_table.lambda_handler(_idem_event("key-lease"), lambda_context)

    marker = _marker(gate_with_table, "key-lease")
    assert marker is not None
    lease = int(marker["ttl"]) - int(marker["startedAt"])
    assert lease == gate_with_table.IDEMPOTENCY_LEASE_SECONDS
    assert lease < gate_with_table.IDEMPOTENCY_TTL_SECONDS


def test_freezing_an_outcome_promotes_the_lease_to_the_full_ttl(
    gate_with_table, lambda_context
):
    """The frozen outcome is the thing that must outlive every retry."""
    resp = gate_with_table.lambda_handler(_idem_event("key-promote"), lambda_context)
    assert resp["statusCode"] == 200

    marker = _marker(gate_with_table, "key-promote")
    assert "outcomeStatus" in marker
    span = int(marker["ttl"]) - int(marker["startedAt"])
    assert span >= gate_with_table.IDEMPOTENCY_TTL_SECONDS - 5


def test_reusing_a_key_for_a_different_action_is_refused(
    gate_with_table, lambda_context
):
    """Nothing tied a replayed outcome to the request that produced it, so a
    caller reusing one key for a different action got the FIRST request's frozen
    response as though it were its own — told its send succeeded when what
    actually went out was something else."""
    first = gate_with_table.lambda_handler(_idem_event("key-reuse"), lambda_context)
    assert first["statusCode"] == 200

    other = _idem_event("key-reuse")
    body = json.loads(other["body"])
    body["payload"] = {
        **body.get("payload", {}),
        "message": "a completely different message",
    }
    other["body"] = json.dumps(body)

    second = gate_with_table.lambda_handler(other, lambda_context)

    assert second["statusCode"] == 422
    assert json.loads(second["body"])["code"] == "IDEMPOTENCY_KEY_REUSED"
    # And it must not have replayed the first outcome or dispatched again.
    assert gate_with_table.create_command.call_count == 1


def test_the_same_request_still_replays(gate_with_table, lambda_context):
    """The fingerprint must not break the case the key exists for."""
    first = gate_with_table.lambda_handler(_idem_event("key-same"), lambda_context)
    second = gate_with_table.lambda_handler(_idem_event("key-same"), lambda_context)

    assert second["statusCode"] == first["statusCode"]
    assert json.loads(second["body"]) == json.loads(first["body"])
    assert gate_with_table.create_command.call_count == 1


def test_an_expired_lease_can_be_reclaimed(gate_with_table, lambda_context):
    """A claim abandoned between the write and the freeze must become claimable
    once its lease lapses. Keying the condition on attribute_not_exists alone
    meant waiting for DynamoDB to physically delete the row, which it only
    promises to do "typically within 48 hours" — so the documented 15-minute
    lease was not the real reclaim window."""
    gate_with_table.lambda_handler(_idem_event('key-stale'), lambda_context)
    assert gate_with_table.create_command.call_count == 1

    # Age the lease past its ttl without deleting the row, exactly as an
    # abandoned claim looks before DynamoDB gets round to reaping it.
    key = gate_with_table._idem_key('user-1', 'key-stale')
    gate_with_table.table.update_item(
        Key=key,
        UpdateExpression='SET #ttl = :past REMOVE outcomeStatus, outcomeBody',
        ExpressionAttributeNames={'#ttl': 'ttl'},
        ExpressionAttributeValues={':past': 1},
    )

    replay = gate_with_table.lambda_handler(_idem_event('key-stale'), lambda_context)

    assert replay['statusCode'] == 200
    assert gate_with_table.create_command.call_count == 2, (
        'an expired lease must be reclaimed and the action dispatched, not blocked until the '
        'row is physically reaped'
    )


def test_a_marker_without_a_fingerprint_is_trusted(gate_with_table, lambda_context):
    """Markers written before the field existed must keep replaying, or a deploy
    would 422 every request already in flight."""
    gate_with_table.lambda_handler(_idem_event("key-legacy"), lambda_context)

    # 'user-1', matching _idem_event's own default sub. Addressing this to
    # 'test-user-sub' created a brand-new USER#test-user-sub item, stripped a
    # fingerprint that was never there, and left the real USER#user-1 marker
    # with its fingerprint intact — so the replay below succeeded through the
    # ordinary matching-fingerprint path and the legacy branch this test names
    # was never entered. The assertions passed either way.
    key = gate_with_table._idem_key("user-1", "key-legacy")
    gate_with_table.table.update_item(Key=key, UpdateExpression="REMOVE fingerprint")
    assert "fingerprint" not in (_marker(gate_with_table, "key-legacy") or {}), (
        "the marker under test must actually have lost its fingerprint"
    )

    replay = gate_with_table.lambda_handler(_idem_event("key-legacy"), lambda_context)
    assert replay["statusCode"] == 200
    assert gate_with_table.create_command.call_count == 1
