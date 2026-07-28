"""Circuit Breaker pattern for external service calls.

Prevents cascading failures by tracking error rates and temporarily
disabling calls to failing services. Transitions:
  closed (healthy) -> open (failing) -> half_open (testing) -> closed
"""

import logging
import time
from collections.abc import Callable
from decimal import Decimal
from typing import Any, Protocol

from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

# Marker string carried in the log MESSAGE (not in `extra`) whenever the breaker
# fails to persist its state. It has to be in the message: the structured
# formatter in observability.py filters `extra` through an allowlist, so an
# extra field a metric filter keys on would silently never be emitted. Both SAM
# templates declare a CloudWatch metric filter matching this literal.
PERSIST_FAILURE_MARKER = 'CIRCUIT_BREAKER_PERSIST_FAILED'


def _to_dynamo_number(value: Any) -> Any:
    """Coerce a Python float to ``Decimal`` for the boto3 DynamoDB resource API.

    The resource API rejects floats outright with
    ``TypeError: Float types are not supported. Use Decimal types instead.``
    ``last_failure_time`` is a ``time.time()`` float, so before this coercion
    every failure-path write raised that TypeError, which ``set_state``'s
    best-effort ``except Exception`` swallowed — a DynamoDB-backed breaker
    persisted nothing at all and therefore could never open.
    """
    if isinstance(value, float):
        return Decimal(str(value))
    return value


class CircuitBreakerStore(Protocol):
    """Protocol for circuit breaker state storage."""

    def get_state(self, service_name: str) -> dict[str, Any]: ...
    def set_state(self, service_name: str, state_data: dict[str, Any]) -> None: ...
    def increment_failure(self, service_name: str, *, now: float) -> dict[str, Any]: ...
    def try_open(self, service_name: str, *, now: float) -> bool: ...


class InMemoryStore:
    """Default in-memory storage for circuit breaker state."""

    def __init__(self):
        self._storage: dict[str, dict[str, Any]] = {}
        self.persist_failed = False

    def get_state(self, service_name: str) -> dict[str, Any]:
        return self._storage.get(service_name, {})

    def set_state(self, service_name: str, state_data: dict[str, Any]) -> None:
        self._storage[service_name] = state_data

    def increment_failure(self, service_name: str, *, now: float) -> dict[str, Any]:
        """Increment and return the new state. Single-process, so a plain
        read-modify-write is genuinely atomic here."""
        state = dict(self._storage.get(service_name, {}))
        state['failure_count'] = int(state.get('failure_count', 0)) + 1
        state['last_failure_time'] = now
        self._storage[service_name] = state
        return state

    def try_open(self, service_name: str, *, now: float) -> bool:
        """Flip to ``open`` unless already open. Returns whether it transitioned."""
        state = dict(self._storage.get(service_name, {}))
        if state.get('state') == 'open':
            return False
        state.update(state='open', last_failure_time=now, half_open_calls=0)
        self._storage[service_name] = state
        return True


class DynamoDBStore:
    """DynamoDB-backed storage for distributed circuit breaker state."""

    def __init__(self, table, ttl_seconds: int = 86400, fail_open: bool = False):
        """Initialize DynamoDB-backed circuit breaker store.

        Args:
            table: DynamoDB table resource.
            ttl_seconds: TTL for state records. Default 24h. A shorter TTL risks
                silent reset to closed while a downstream service is still failing.
            fail_open: If True, treat DynamoDB read failures as 'no record'
                (circuit assumed healthy). Default False (re-raise), so caller
                can degrade explicitly rather than silently assuming health.
        """
        self.table = table
        self.ttl_seconds = ttl_seconds
        self.fail_open = fail_open
        # Set whenever a write is swallowed. Writes stay best-effort by design —
        # a breaker that cannot persist must not break the caller's code — but a
        # swallowed write used to leave no signal at all, so a breaker degraded
        # into a no-op silently. Callers can read it; the marker log below is
        # what the CloudWatch alarm keys on.
        self.persist_failed = False

    def _key(self, service_name: str) -> dict[str, str]:
        return {'PK': f'CB#{service_name}', 'SK': 'STATE'}

    def _record_persist_failure(self, service_name: str, operation: str) -> None:
        self.persist_failed = True
        logger.exception(
            '%s service=%s operation=%s',
            PERSIST_FAILURE_MARKER,
            service_name,
            operation,
            extra={'subsystem': 'circuit_breaker', 'service_name': service_name},
        )

    def get_state(self, service_name: str) -> dict[str, Any]:
        try:
            resp = self.table.get_item(Key={'PK': f'CB#{service_name}', 'SK': 'STATE'})
            return resp.get('Item', {})
        except ClientError as e:
            code = e.response.get('Error', {}).get('Code', 'Unknown')
            logger.exception(
                'Failed to get circuit breaker state from DynamoDB',
                extra={
                    'subsystem': 'circuit_breaker',
                    'service_name': service_name,
                    'error_code': code,
                },
            )
            if self.fail_open:
                # Caller opted in: assume healthy on DDB outage.
                return {}
            raise

    def set_state(self, service_name: str, state_data: dict[str, Any]) -> None:
        """Full-item write, used for the idempotent ``closed``/``half_open``
        resets. The failure counter does NOT go through here — see
        :meth:`increment_failure`."""
        try:
            item = {
                'PK': f'CB#{service_name}',
                'SK': 'STATE',
                'ttl': int(time.time()) + self.ttl_seconds,
                **{k: _to_dynamo_number(v) for k, v in state_data.items()},
            }
            self.table.put_item(Item=item)
        except ClientError:
            self._record_persist_failure(service_name, 'set_state')
        except Exception:
            # set_state is best-effort: serialization errors, float/decimal
            # coercion, and other boto runtime issues must not break the
            # circuit breaker's in-memory protection around the caller's code.
            self._record_persist_failure(service_name, 'set_state')

    def increment_failure(self, service_name: str, *, now: float) -> dict[str, Any]:
        """Atomically bump ``failure_count`` and return the authoritative item.

        A single ``ADD`` update, so concurrent invocations sharing the
        ``CB#<service>/STATE`` item each observe a distinct total. The previous
        read-increment-write through :meth:`set_state` meant every concurrent
        invocation read 0 and wrote 1 — under exactly the concurrency where a
        breaker matters, the count never reached ``failure_threshold``.

        Returns ``{}`` when the update could not be performed, so the caller can
        fall back to its local count rather than losing the failure entirely.
        """
        try:
            resp = self.table.update_item(
                Key=self._key(service_name),
                UpdateExpression=('ADD failure_count :one SET last_failure_time = :now, #ttl = :ttl'),
                ExpressionAttributeNames={'#ttl': 'ttl'},
                ExpressionAttributeValues={
                    ':one': 1,
                    ':now': _to_dynamo_number(now),
                    ':ttl': int(time.time()) + self.ttl_seconds,
                },
                ReturnValues='ALL_NEW',
            )
            return resp.get('Attributes', {}) or {}
        except ClientError:
            self._record_persist_failure(service_name, 'increment_failure')
            return {}
        except Exception:
            self._record_persist_failure(service_name, 'increment_failure')
            return {}

    def try_open(self, service_name: str, *, now: float) -> bool:
        """Conditionally flip the circuit to ``open``.

        Guarded by ``#state <> :open`` so two invocations crossing the threshold
        together produce exactly one transition (and therefore one log line),
        not two. Returns ``False`` when another invocation got there first, or
        when the write could not be performed at all.
        """
        try:
            self.table.update_item(
                Key=self._key(service_name),
                UpdateExpression=('SET #state = :open, last_failure_time = :now, half_open_calls = :zero, #ttl = :ttl'),
                ConditionExpression='attribute_not_exists(#state) OR #state <> :open',
                ExpressionAttributeNames={'#state': 'state', '#ttl': 'ttl'},
                ExpressionAttributeValues={
                    ':open': 'open',
                    ':now': _to_dynamo_number(now),
                    ':zero': 0,
                    ':ttl': int(time.time()) + self.ttl_seconds,
                },
            )
            return True
        except ClientError as e:
            if e.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
                # Another invocation already opened it. Not a failure.
                return False
            self._record_persist_failure(service_name, 'try_open')
            return False
        except Exception:
            self._record_persist_failure(service_name, 'try_open')
            return False


class CachedDynamoDBStore:
    """DynamoDB store with short-lived in-memory cache to reduce round trips.

    Wraps DynamoDBStore with a per-service-name TTL cache. Within a single
    Lambda invocation the circuit state rarely changes between consecutive
    reads, so caching for a few seconds eliminates redundant DynamoDB calls
    (typically from 2-3 per circuit breaker call down to 0-1).
    """

    def __init__(
        self,
        table,
        ttl_seconds: int = 3600,
        cache_ttl_seconds: float = 5.0,
        fail_open: bool = False,
    ):
        self._inner = DynamoDBStore(table, ttl_seconds, fail_open=fail_open)
        self._cache_ttl = cache_ttl_seconds
        self._cache: dict[str, dict[str, Any]] = {}
        self._cache_ts: dict[str, float] = {}

    def _is_fresh(self, service_name: str) -> bool:
        ts = self._cache_ts.get(service_name)
        if ts is None:
            return False
        return (time.time() - ts) < self._cache_ttl

    def get_state(self, service_name: str) -> dict[str, Any]:
        if self._is_fresh(service_name):
            return self._cache[service_name]
        state = self._inner.get_state(service_name)
        self._cache[service_name] = state
        self._cache_ts[service_name] = time.time()
        return state

    @property
    def persist_failed(self) -> bool:
        return self._inner.persist_failed

    def set_state(self, service_name: str, state_data: dict[str, Any]) -> None:
        self._inner.set_state(service_name, state_data)
        # Update cache immediately so subsequent reads see the new state
        self._cache[service_name] = state_data
        self._cache_ts[service_name] = time.time()

    def increment_failure(self, service_name: str, *, now: float) -> dict[str, Any]:
        state = self._inner.increment_failure(service_name, now=now)
        # The ADD result is authoritative; caching anything else here would hand
        # the next read a count the store has already moved past.
        if state:
            self._cache[service_name] = state
            self._cache_ts[service_name] = time.time()
        else:
            self._cache.pop(service_name, None)
            self._cache_ts.pop(service_name, None)
        return state

    def try_open(self, service_name: str, *, now: float) -> bool:
        opened = self._inner.try_open(service_name, now=now)
        # Either way the cached copy is now stale — a failed conditional write
        # means somebody else changed the item.
        self._cache.pop(service_name, None)
        self._cache_ts.pop(service_name, None)
        return opened


class CircuitBreakerOpenError(Exception):
    """Raised when circuit is open and calls are rejected."""

    def __init__(self, service_name: str, recovery_time_remaining: float):
        self.service_name = service_name
        self.recovery_time_remaining = recovery_time_remaining
        super().__init__(f"Circuit breaker open for '{service_name}'. Retry in {recovery_time_remaining:.1f}s")


class CircuitBreaker:
    """
    Circuit breaker with three states: closed, open, half_open.

    Args:
        service_name: Name for logging and error messages
        failure_threshold: Number of consecutive failures to trip the breaker
        recovery_timeout: Seconds to wait before attempting recovery
        half_open_max_calls: Max calls allowed in half-open state
        store: Optional storage backend (defaults to InMemoryStore)
    """

    def __init__(
        self,
        service_name: str = 'unknown',
        failure_threshold: int = 5,
        recovery_timeout: float = 60.0,
        half_open_max_calls: int = 1,
        store: CircuitBreakerStore | None = None,
    ):
        self.service_name = service_name
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.half_open_max_calls = half_open_max_calls
        self.store = store or InMemoryStore()

    def _get_local_state(self) -> dict[str, Any]:
        state = self.store.get_state(self.service_name)
        last_failure_time = state.get('last_failure_time')
        return {
            'state': state.get('state', 'closed'),
            'failure_count': int(state.get('failure_count', 0)),
            # DynamoDB hands numbers back as Decimal. _should_attempt_recovery
            # subtracts this from time.time(), and float - Decimal is a
            # TypeError, so normalise at the read boundary rather than at every
            # arithmetic site. (Latent until the failure-path write started
            # persisting at all — nothing was ever read back before.)
            'last_failure_time': None if last_failure_time is None else float(last_failure_time),
            'half_open_calls': int(state.get('half_open_calls', 0)),
        }

    def _update_local_state(self, **kwargs: Any) -> None:
        current = self._get_local_state()
        current.update(kwargs)
        self.store.set_state(self.service_name, current)

    @property
    def state(self) -> str:
        """Current circuit state, checking if open circuit should transition to half-open.

        The open -> half_open transition is implemented identically here and in
        ``call()``. Both paths do a read-then-write against the store without a
        lock, so they are race-safe only under a single-threaded executor (the
        Lambda Python worker model). If ``DynamoDBStore`` is ever used from
        concurrent threads or processes, wrap both transitions in a conditional
        update (e.g. ``attribute_exists AND #state = :open``) so only one
        caller performs the promotion.

        This reasoning covers threads within one invocation. It deliberately
        does NOT cover the failure counter, which concurrent *invocations* race
        on through one shared DynamoDB item: that is handled separately by
        ``store.increment_failure`` (an atomic ``ADD``) and ``store.try_open``
        (a conditional write). The worst case here is an extra probe call in
        half-open, which the half_open_max_calls budget already bounds; the
        worst case for the counter was a breaker that never opened, which is
        why only the counter got the stronger primitive.
        """
        data = self._get_local_state()
        state = data['state']
        last_failure_time = data['last_failure_time']

        if state == 'open' and self._should_attempt_recovery(last_failure_time):
            state = 'half_open'
            self._update_local_state(state=state, half_open_calls=0)
            logger.info("Circuit breaker '%s': open -> half_open", self.service_name)
        return state

    def call(self, func: Callable, *args: Any, **kwargs: Any) -> Any:
        """Execute function through the circuit breaker."""
        data = self._get_local_state()
        current_state = data['state']

        # Check open -> half_open transition inline (mirrors .state property logic)
        if current_state == 'open' and self._should_attempt_recovery(data['last_failure_time']):
            current_state = 'half_open'
            self._update_local_state(state=current_state, half_open_calls=0)
            data = self._get_local_state()
            logger.info("Circuit breaker '%s': open -> half_open", self.service_name)

        if current_state == 'open':
            remaining = self.recovery_timeout - (time.time() - (data['last_failure_time'] or 0))
            raise CircuitBreakerOpenError(self.service_name, max(0, remaining))

        if current_state == 'half_open' and data['half_open_calls'] >= self.half_open_max_calls:
            raise CircuitBreakerOpenError(self.service_name, self.recovery_timeout)

        try:
            if current_state == 'half_open':
                self._update_local_state(half_open_calls=data['half_open_calls'] + 1)

            result = func(*args, **kwargs)
            self.on_success()
            return result
        except Exception as e:
            self.on_failure(e)
            raise

    def on_success(self) -> None:
        """Reset failure tracking on successful call."""
        data = self._get_local_state()
        if data['state'] == 'half_open':
            logger.info("Circuit breaker '%s': half_open -> closed (recovery successful)", self.service_name)
        self._update_local_state(state='closed', failure_count=0, last_failure_time=None, half_open_calls=0)

    @property
    def persist_failed(self) -> bool:
        """True once a state write has been swallowed.

        Persistence is best-effort by design, so this never raises — but a
        breaker that cannot persist has degraded into a no-op, and a caller that
        wants to say so in its own logs can read this.
        """
        return bool(getattr(self.store, 'persist_failed', False))

    def on_failure(self, error: Exception) -> None:
        """Track failure and potentially trip the breaker.

        The counter is incremented with a single atomic ``ADD`` and the returned
        value is authoritative — no read-modify-write, so concurrent invocations
        sharing one stored item cannot lose each other's increments. The
        ``-> open`` flip is a conditional write, so a simultaneous threshold
        crossing produces one transition rather than one per invocation.
        """
        data = self._get_local_state()
        now = time.time()

        incremented = self.store.increment_failure(self.service_name, now=now)
        if incremented:
            new_count = int(incremented.get('failure_count', data['failure_count'] + 1))
        else:
            # The store could not record the increment (and has already flagged
            # persist_failed). Fall back to the local count so the in-process
            # breaker still protects this invocation.
            new_count = data['failure_count'] + 1

        if data['state'] == 'half_open':
            if self._open_or_fall_back_locally(now=now):
                logger.warning(
                    "Circuit breaker '%s': half_open -> open (recovery failed: %s)", self.service_name, error
                )
        elif new_count >= self.failure_threshold and self._open_or_fall_back_locally(now=now):
            logger.warning(
                "Circuit breaker '%s': closed -> open (threshold %s reached: %s)",
                self.service_name,
                self.failure_threshold,
                error,
            )

    def _open_or_fall_back_locally(self, *, now: float) -> bool:
        """Flip to ``open``, and make sure THIS process opens even when the
        shared store cannot record it.

        ``try_open`` returns False for two unrelated reasons: another invocation
        already opened the circuit (nothing to do — it IS open), or the write
        failed (nothing opened at all). Making the transition conditional on the
        write turned the second case into a breaker that never opens: the count
        keeps climbing, ``CachedDynamoDBStore.try_open`` drops the cached copy so
        the next read reports ``closed``, and every caller keeps paying the full
        downstream timeout instead of failing fast.

        The old failure path did not have this hole because it wrote the open
        state through ``set_state``, which updates the cache whether or not
        DynamoDB accepted the item. That fallback is restored here, gated on the
        store telling us it could not persist, so an ordinary lost race still
        returns False.
        """
        if self.store.try_open(self.service_name, now=now):
            return True
        if getattr(self.store, 'persist_failed', False):
            self._update_local_state(state='open', last_failure_time=now, half_open_calls=0)
            logger.warning(
                "Circuit breaker '%s': opened in-process only — the shared store could not record it",
                self.service_name,
            )
            return True
        return False

    def _should_attempt_recovery(self, last_failure_time: float | None) -> bool:
        """Check if enough time has passed to attempt recovery."""
        if last_failure_time is None:
            return True
        return (time.time() - last_failure_time) >= self.recovery_timeout

    def reset(self) -> None:
        """Manually reset the circuit breaker to closed state."""
        self._update_local_state(state='closed', failure_count=0, last_failure_time=None, half_open_calls=0)

    def to_dict(self) -> dict[str, Any]:
        """Return circuit breaker state as a dictionary for observability."""
        data = self._get_local_state()
        return {
            'service_name': self.service_name,
            'state': self.state,
            'failure_count': data['failure_count'],
            'failure_threshold': self.failure_threshold,
            'recovery_timeout': self.recovery_timeout,
        }
