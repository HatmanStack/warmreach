"""Unit tests for the shared OpenAI transient-error retry wrapper."""

from unittest.mock import MagicMock, patch

import openai
import pytest
from shared_services.openai_retry import (
    MAX_RETRIES,
    RETRY_BACKOFF_BASE_S,
    retry_openai_call,
)


@patch('shared_services.openai_retry.time.sleep', return_value=None)
def test_returns_immediately_on_success(mock_sleep):
    fn = MagicMock(return_value='ok')
    assert retry_openai_call(fn) == 'ok'
    fn.assert_called_once()
    mock_sleep.assert_not_called()


@patch('shared_services.openai_retry.time.sleep', return_value=None)
def test_retries_transient_then_succeeds(mock_sleep):
    fn = MagicMock(side_effect=[openai.APITimeoutError(request=MagicMock()), 'recovered'])
    assert retry_openai_call(fn) == 'recovered'
    assert fn.call_count == 2
    mock_sleep.assert_called_once()


@patch('shared_services.openai_retry.time.sleep', return_value=None)
def test_exhausts_retries_then_raises(mock_sleep):
    err = openai.APIConnectionError(request=MagicMock())
    fn = MagicMock(side_effect=err)
    with pytest.raises(openai.APIConnectionError):
        retry_openai_call(fn)
    assert fn.call_count == MAX_RETRIES
    # One sleep between each of the MAX_RETRIES attempts except the last.
    assert mock_sleep.call_count == MAX_RETRIES - 1
    # Exponential backoff with equal jitter: each delay lands in
    # [backoff/2, backoff) for backoff = base, then base*2.
    delays = [c.args[0] for c in mock_sleep.call_args_list]
    for attempt, delay in enumerate(delays):
        backoff = RETRY_BACKOFF_BASE_S * (2**attempt)
        assert backoff / 2 <= delay < backoff


@patch('shared_services.openai_retry.time.sleep', return_value=None)
def test_non_transient_error_not_retried(mock_sleep):
    resp = MagicMock()
    resp.status_code = 400
    resp.request = MagicMock()
    fn = MagicMock(side_effect=openai.BadRequestError('bad', response=resp, body=None))
    with pytest.raises(openai.BadRequestError):
        retry_openai_call(fn)
    fn.assert_called_once()
    mock_sleep.assert_not_called()


@patch('shared_services.openai_retry.time.sleep', return_value=None)
def test_custom_sleep_callable_used(mock_sleep):
    sleeps: list[float] = []
    fn = MagicMock(side_effect=[openai.RateLimitError('rl', response=MagicMock(status_code=429), body=None), 'ok'])
    assert retry_openai_call(fn, sleep=sleeps.append) == 'ok'
    assert len(sleeps) == 1
    assert RETRY_BACKOFF_BASE_S / 2 <= sleeps[0] < RETRY_BACKOFF_BASE_S
    # The injected sleep is used instead of the module-level time.sleep.
    mock_sleep.assert_not_called()


# --- Equal jitter (eval Tier 2 item 15) --------------------------------------
# Without jitter every concurrent invocation that hit the same 429 slept the
# identical 2s then 4s and retried in lockstep, re-colliding with the rate limit
# it was backing off from.


def _rate_limited():
    return openai.RateLimitError('rl', response=MagicMock(status_code=429), body=None)


@patch('shared_services.openai_retry.time.sleep', return_value=None)
def test_injected_rng_makes_the_jittered_delay_exact(mock_sleep):
    sleeps: list[float] = []
    fn = MagicMock(side_effect=[_rate_limited(), _rate_limited(), 'ok'])
    # rng() == 0 -> the shortest permitted delay, exactly backoff/2.
    assert retry_openai_call(fn, sleep=sleeps.append, rng=lambda: 0.0) == 'ok'
    assert sleeps == [RETRY_BACKOFF_BASE_S / 2, RETRY_BACKOFF_BASE_S]

    sleeps.clear()
    fn = MagicMock(side_effect=[_rate_limited(), _rate_limited(), 'ok'])
    assert retry_openai_call(fn, sleep=sleeps.append, rng=lambda: 0.5) == 'ok'
    assert sleeps == [RETRY_BACKOFF_BASE_S * 0.75, RETRY_BACKOFF_BASE_S * 1.5]


@patch('shared_services.openai_retry.time.sleep', return_value=None)
def test_jitter_never_exceeds_the_previous_fixed_backoff(mock_sleep):
    """Equal jitter only ever shortens the wait, so the worst-case wall clock
    the module docstring promises does not grow."""
    sleeps: list[float] = []
    fn = MagicMock(side_effect=[_rate_limited(), _rate_limited(), 'ok'])
    assert retry_openai_call(fn, sleep=sleeps.append, rng=lambda: 0.999999) == 'ok'
    for attempt, delay in enumerate(sleeps):
        assert delay < RETRY_BACKOFF_BASE_S * (2**attempt)


@patch('shared_services.openai_retry.time.sleep', return_value=None)
def test_two_concurrent_callers_do_not_sleep_in_lockstep(mock_sleep):
    """The property that actually matters. Seeded RNGs keep it deterministic."""
    import random

    def run(seed):
        sleeps: list[float] = []
        fn = MagicMock(side_effect=[_rate_limited(), _rate_limited(), 'ok'])
        retry_openai_call(fn, sleep=sleeps.append, rng=random.Random(seed).random)
        return sleeps

    assert run(1) != run(2)


@patch('shared_services.openai_retry.time.sleep', return_value=None)
def test_retryable_error_set_is_unchanged(mock_sleep):
    """Jitter must not widen or narrow what counts as transient."""
    for err in (
        openai.APIConnectionError(request=MagicMock()),
        openai.APITimeoutError(request=MagicMock()),
        _rate_limited(),
        openai.InternalServerError('boom', response=MagicMock(status_code=500), body=None),
    ):
        fn = MagicMock(side_effect=[err, 'ok'])
        assert retry_openai_call(fn, sleep=lambda _: None) == 'ok'
        assert fn.call_count == 2
