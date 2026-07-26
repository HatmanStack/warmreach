"""Tests for LLM token accounting and cost attribution.

The tier grants were priced against modelled token volumes because nothing
measured them. These cover the module that replaces the model with a
measurement, and in particular the ways it must fail quietly: a metering bug
must never discard a response the user has already been billed for.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from shared_services.llm_cost import (
    MICRO_USD,
    MODEL_PRICING,
    TOOL_AUGMENTED_OPERATIONS,
    TokenUsage,
    estimate_cost_usd,
    extract_usage,
    record_llm_usage,
)


def _response(input_tokens=None, output_tokens=None, cached=None, reasoning=None, *, usage=True):
    if not usage:
        return SimpleNamespace(id='resp_1')
    return SimpleNamespace(
        id='resp_1',
        usage=SimpleNamespace(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            input_tokens_details=SimpleNamespace(cached_tokens=cached) if cached is not None else None,
            output_tokens_details=SimpleNamespace(reasoning_tokens=reasoning) if reasoning is not None else None,
        ),
    )


class TestExtractUsage:
    def test_reads_responses_api_shape(self):
        usage = extract_usage(_response(2000, 500, cached=300, reasoning=120))

        assert usage.input_tokens == 2000
        assert usage.output_tokens == 500
        assert usage.cached_input_tokens == 300
        assert usage.reasoning_tokens == 120
        assert usage.total_tokens == 2500

    def test_accepts_chat_completions_naming(self):
        """A caller switching APIs must not silently stop reporting."""
        response = SimpleNamespace(usage=SimpleNamespace(prompt_tokens=10, completion_tokens=4))

        usage = extract_usage(response)

        assert usage.input_tokens == 10
        assert usage.output_tokens == 4

    @pytest.mark.parametrize(
        'response',
        [
            _response(usage=False),
            SimpleNamespace(usage=None),
            SimpleNamespace(usage=SimpleNamespace(input_tokens='oops', output_tokens=None)),
        ],
    )
    def test_degrades_to_zero_rather_than_raising(self, response):
        """This runs after a paid call — a shape change must not lose the response."""
        assert extract_usage(response) == TokenUsage()

    def test_cached_tokens_cannot_exceed_input(self):
        # A nonsensical payload must not produce a negative uncached count and
        # thus a negative cost.
        usage = extract_usage(_response(100, 10, cached=500))

        assert usage.cached_input_tokens == 100


class TestEstimateCost:
    def test_prices_a_known_model(self):
        # terra: $2.50/1M input, $15.00/1M output
        cost = estimate_cost_usd('gpt-5.6-terra', TokenUsage(input_tokens=2000, output_tokens=500))

        assert cost == pytest.approx(2000 * 2.50 / 1e6 + 500 * 15.00 / 1e6)
        assert cost == pytest.approx(0.0125)

    def test_returns_none_for_an_unpriced_model(self):
        """None, not 0.0 — a zero would average in as 'this model is free'."""
        assert estimate_cost_usd('some-future-model', TokenUsage(input_tokens=1000)) is None

    def test_cached_input_falls_back_to_the_full_rate(self):
        """Over-stating cost is the safe direction for a pricing decision."""
        priced = estimate_cost_usd('gpt-5.6-terra', TokenUsage(input_tokens=1000, cached_input_tokens=1000))

        assert priced == pytest.approx(1000 * 2.50 / 1e6)

    def test_every_registry_default_is_priced(self):
        """An unpriced default silently disables cost reporting for every call."""
        from shared_services import model_config

        for key in (
            'MODEL_GENERAL',
            'MODEL_ANALYSIS',
            'MODEL_DEEP_RESEARCH',
            'DEFAULT_PLANNER_MODEL',
        ):
            model = getattr(model_config, key)
            assert model in MODEL_PRICING, f'{key}={model} has no entry in MODEL_PRICING'

    def test_zero_usage_costs_nothing(self):
        assert estimate_cost_usd('gpt-5.6-terra', TokenUsage()) == 0.0


class TestRecordUsage:
    def test_writes_a_monthly_counter_in_micro_usd(self):
        table = MagicMock()

        record_llm_usage(
            table,
            'user-1',
            model='gpt-5.6-terra',
            operation='generate_message',
            response=_response(2000, 500),
        )

        table.update_item.assert_called_once()
        kwargs = table.update_item.call_args.kwargs
        assert kwargs['Key']['PK'] == 'USER#user-1'
        assert kwargs['Key']['SK'].startswith('USAGE#cost#monthly#')
        values = kwargs['ExpressionAttributeValues']
        # $0.0125 -> 12500 micro-USD, exact integer arithmetic.
        assert values[':cost'] == int(round(0.0125 * MICRO_USD)) == 12500
        assert values[':inp'] == 2000
        assert values[':out'] == 500
        assert values[':one'] == 1

    def test_never_raises_when_dynamodb_fails(self):
        """Metering must not fail a call the user has already been billed for."""
        table = MagicMock()
        table.update_item.side_effect = RuntimeError('throttled')

        usage = record_llm_usage(
            table,
            'user-1',
            model='gpt-5.6-terra',
            operation='generate_message',
            response=_response(10, 5),
        )

        assert usage.input_tokens == 10

    def test_records_tokens_for_an_unpriced_model(self):
        """The cost is unknown, not the usage — token volume is still worth having."""
        table = MagicMock()

        record_llm_usage(
            table,
            'user-1',
            model='mystery-model',
            operation='generate_message',
            response=_response(10, 5),
        )

        values = table.update_item.call_args.kwargs['ExpressionAttributeValues']
        assert values[':inp'] == 10
        assert values[':out'] == 5
        assert values[':cost'] == 0

    def test_writes_nothing_for_a_queued_background_job(self):
        """background=True returns before any tokens exist.

        Writing callCount=1 with microUsd=0 would put a row reading "this call
        was free" against the single most expensive operation in the system.
        """
        table = MagicMock()

        usage = record_llm_usage(
            table,
            'user-1',
            model='o4-mini-deep-research',
            operation='research_selected_ideas',
            response=SimpleNamespace(id='resp_bg', status='queued'),
        )

        table.update_item.assert_not_called()
        assert usage.total_tokens == 0

    def test_queued_calls_are_marked_deferred_in_the_log(self, caplog):
        import logging

        with caplog.at_level(logging.INFO):
            record_llm_usage(
                None,
                None,
                model='o4-mini-deep-research',
                operation='research_selected_ideas',
                response=SimpleNamespace(id='resp_bg'),
            )

        record = next(r for r in caplog.records if r.msg == 'llm_usage')
        assert record.deferred is True

    @pytest.mark.parametrize(('table', 'user'), [(None, 'user-1'), (MagicMock(), None)])
    def test_tolerates_a_missing_table_or_user(self, table, user):
        usage = record_llm_usage(
            table,
            user,
            model='gpt-5.6-terra',
            operation='generate_message',
            response=_response(10, 5),
        )

        assert usage.output_tokens == 5

    def test_flags_operations_whose_real_bill_exceeds_tokens(self, caplog):
        """Deep research adds per-call web-search and code-interpreter fees."""
        import logging

        with caplog.at_level(logging.INFO):
            record_llm_usage(
                None,
                None,
                model='o4-mini-deep-research',
                operation='research_selected_ideas',
                response=_response(100, 50),
            )

        record = next(r for r in caplog.records if r.msg == 'llm_usage')
        assert record.excludes_tool_fees is True
        assert 'research_selected_ideas' in TOOL_AUGMENTED_OPERATIONS

    def test_ordinary_operations_are_not_flagged(self, caplog):
        import logging

        with caplog.at_level(logging.INFO):
            record_llm_usage(
                None,
                None,
                model='gpt-5.6-terra',
                operation='generate_message',
                response=_response(100, 50),
            )

        record = next(r for r in caplog.records if r.msg == 'llm_usage')
        assert record.excludes_tool_fees is False
        assert record.cost_usd is not None


class TestLLMServiceWiring:
    """The module is only useful if the call path actually uses it."""

    @pytest.fixture
    def service_module(self):
        from conftest import load_service_class

        return load_service_class('llm', 'llm_service')

    def _service(self, module, response):
        client = MagicMock()
        client.responses.create.return_value = response
        return module.LLMService(openai_client=client, table=MagicMock()), client

    def test_applies_the_per_operation_output_cap(self, service_module):
        svc, client = self._service(service_module, _response(10, 5))

        svc._openai_responses_create(model='gpt-5.6-terra', input='hi', _operation='generate_message')

        sent = client.responses.create.call_args.kwargs
        assert sent['max_output_tokens'] == service_module.OPERATION_MAX_OUTPUT_TOKENS['generate_message']

    def test_an_explicit_cap_wins(self, service_module):
        svc, client = self._service(service_module, _response(10, 5))

        svc._openai_responses_create(
            model='gpt-5.6-terra', input='hi', _operation='generate_message', max_output_tokens=42
        )

        assert client.responses.create.call_args.kwargs['max_output_tokens'] == 42

    def test_uncapped_operations_send_no_limit(self, service_module):
        """Deep research output length is the product; truncating it is not a saving."""
        svc, client = self._service(service_module, _response(10, 5))

        svc._openai_responses_create(model='o4-mini-deep-research', input='hi', _operation='research_selected_ideas')

        assert 'max_output_tokens' not in client.responses.create.call_args.kwargs

    def test_metering_args_are_never_forwarded_to_openai(self, service_module):
        """A leaked _operation kwarg would be rejected by the API."""
        svc, client = self._service(service_module, _response(10, 5))

        svc._openai_responses_create(
            model='gpt-5.6-terra', input='hi', _operation='generate_message', _user_id='user-1'
        )

        sent = client.responses.create.call_args.kwargs
        assert '_operation' not in sent
        assert '_user_id' not in sent

    def test_records_cost_against_the_user(self, service_module):
        svc, _ = self._service(service_module, _response(2000, 500))

        svc._openai_responses_create(
            model='gpt-5.6-terra', input='hi', _operation='generate_message', _user_id='user-1'
        )

        svc.table.update_item.assert_called_once()
        key = svc.table.update_item.call_args.kwargs['Key']
        assert key['PK'] == 'USER#user-1'
        assert key['SK'].startswith('USAGE#cost#monthly#')

    def test_a_metering_failure_does_not_lose_the_response(self, service_module):
        """The user has already been billed by the time this runs."""
        expected = _response(10, 5)
        svc, _ = self._service(service_module, expected)
        svc.table.update_item.side_effect = RuntimeError('throttled')

        got = svc._openai_responses_create(
            model='gpt-5.6-terra', input='hi', _operation='generate_message', _user_id='user-1'
        )

        assert got is expected


class TestFieldsSurviveTheFormatter:
    """The extras are worthless if StructuredJsonFormatter drops them.

    The first version of this module logged all of these and none reached
    CloudWatch: the formatter copies an allowlist, and asserting on
    caplog.records (which holds the raw LogRecord) hid that completely. These
    assert on formatted output instead.
    """

    @pytest.fixture
    def formatted(self):
        import json
        import logging

        from shared_services.observability import StructuredJsonFormatter

        def _emit(**kwargs):
            records = []

            class _Capture(logging.Handler):
                def emit(self, record):
                    records.append(record)

            handler = _Capture()
            logger = logging.getLogger('shared_services.llm_cost')
            previous = logger.level
            logger.addHandler(handler)
            logger.setLevel(logging.INFO)
            try:
                record_llm_usage(None, None, **kwargs)
            finally:
                logger.removeHandler(handler)
                logger.setLevel(previous)
            return [json.loads(StructuredJsonFormatter().format(r)) for r in records]

        return _emit

    def test_cost_fields_reach_the_formatted_output(self, formatted):
        entries = formatted(model='gpt-5.6-terra', operation='generate_message', response=_response(2000, 500))

        entry = next(e for e in entries if e['message'] == 'llm_usage')
        for field in ('model', 'operation', 'input_tokens', 'output_tokens', 'cost_usd'):
            assert field in entry, f'{field} was dropped by StructuredJsonFormatter'
        assert entry['input_tokens'] == 2000
        assert entry['cost_usd'] == pytest.approx(0.0125)

    def test_unpriced_calls_use_the_same_message(self, formatted):
        """A filter on `llm_usage` must not miss them — priced=false marks them."""
        entries = formatted(model='mystery-model', operation='generate_message', response=_response(10, 5))

        entry = next(e for e in entries if e['message'] == 'llm_usage')
        assert entry['priced'] is False
        assert entry['level'] == 'WARNING'


class TestTruncationIsNotMistakenForEmpty:
    """max_output_tokens counts reasoning tokens, so a cap can truncate.

    A truncated reply has empty output_text, which read as "Empty response from
    AI" — and in analyze_tone as silent default scores that look like real
    analysis.
    """

    @pytest.fixture
    def service_module(self):
        from conftest import load_service_class

        return load_service_class('llm', 'llm_service')

    def test_incomplete_response_raises_rather_than_reading_as_empty(self, service_module):
        from errors.exceptions import ExternalServiceError

        svc = service_module.LLMService(openai_client=MagicMock(), table=None)
        truncated = SimpleNamespace(
            status='incomplete',
            incomplete_details=SimpleNamespace(reason='max_output_tokens'),
            output_text='',
        )

        with pytest.raises(ExternalServiceError, match='cut short'):
            svc._extract_response_content(truncated)

    def test_completed_responses_are_unaffected(self, service_module):
        svc = service_module.LLMService(openai_client=MagicMock(), table=None)
        ok = SimpleNamespace(status='completed', output_text='hello')

        assert svc._extract_response_content(ok) == 'hello'

    def test_a_response_with_no_status_field_still_works(self, service_module):
        """Older/mocked responses must not trip the new check."""
        svc = service_module.LLMService(openai_client=MagicMock(), table=None)

        assert svc._extract_response_content(SimpleNamespace(output_text='hi')) == 'hi'

    def test_caps_leave_room_for_reasoning_tokens(self, service_module):
        """A cap small enough to be eaten by reasoning would truncate every call."""
        for operation, cap in service_module.OPERATION_MAX_OUTPUT_TOKENS.items():
            assert cap >= 6_000, f'{operation} cap of {cap} risks truncation on a reasoning model'

    def test_truncation_survives_the_error_wrapper(self, service_module):
        """A truncation error must reach the caller, not be flattened.

        Pro relies on wrap_llm_errors, which propagates typed project errors
        unchanged. The community overlay instead catches Exception in each
        method and would have collapsed truncation into a generic failure —
        fixed separately there. This pins the pro guarantee.
        """
        from errors.exceptions import ExternalServiceError
        from services.errors import map_llm_exception

        original = ExternalServiceError('cut short', service='OpenAI')
        mapped = map_llm_exception(original, operation='generate_message', user_message='generic failure')

        assert mapped is original, 'a typed error was rewritten into a generic one'
