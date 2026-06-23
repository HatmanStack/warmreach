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
    # Exponential backoff: base, then base*2.
    assert [c.args[0] for c in mock_sleep.call_args_list] == [
        RETRY_BACKOFF_BASE_S,
        RETRY_BACKOFF_BASE_S * 2,
    ]


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
    assert sleeps == [RETRY_BACKOFF_BASE_S]
    # The injected sleep is used instead of the module-level time.sleep.
    mock_sleep.assert_not_called()
