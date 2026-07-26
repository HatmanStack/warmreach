"""Token accounting and cost attribution for OpenAI calls.

Before this module there was no usage accounting anywhere in the LLM path, so
cost per operation and per user was unknown — the tier grants were priced
against *modelled* token volumes rather than measured ones. Every paid call now
records what it actually consumed.

Two consumers:

* CloudWatch, via a structured log line per call. Aggregating those gives cost
  per operation and per model, which is what the tier grants should be sized
  against.
* DynamoDB, via a monthly per-user counter, so an individual account's COGS can
  be compared with what it pays. Written as integer micro-USD — DynamoDB has no
  float type and Decimal round-trips of fractional cents are a needless source
  of drift.

Recording is strictly best-effort. A metering failure must never fail a call the
user has already been charged for; the numbers are for our decisions, not
theirs.
"""

import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

#: Retain a year and a bit of monthly cost rows — enough for year-over-year
#: comparison without keeping them forever.
COST_TTL_SECONDS = 400 * 86400

#: One USD in micro-USD. Costs are fractions of a cent, so integer micro-USD
#: keeps the arithmetic exact in DynamoDB.
MICRO_USD = 1_000_000


@dataclass(frozen=True)
class ModelPrice:
    """USD per 1M tokens.

    ``cached_input`` applies to the portion of the prompt OpenAI served from its
    cache. When a model has no published cached rate it falls back to the full
    input rate, which over-states rather than under-states cost — the safer
    direction for a pricing decision.
    """

    input: float
    output: float
    cached_input: float | None = None


#: Published OpenAI rates, USD per 1M tokens, as of 2026-07-25. An unlisted
#: model records tokens but no cost rather than guessing — see estimate_cost_usd.
MODEL_PRICING: dict[str, ModelPrice] = {
    'gpt-5.6-sol': ModelPrice(input=5.00, output=30.00),
    'gpt-5.6-terra': ModelPrice(input=2.50, output=15.00),
    'gpt-5.6-luna': ModelPrice(input=1.00, output=6.00),
    'gpt-5.5': ModelPrice(input=5.00, output=30.00),
    'gpt-5.5-pro': ModelPrice(input=30.00, output=180.00),
    'gpt-5.4': ModelPrice(input=2.50, output=15.00),
    'gpt-5.4-mini': ModelPrice(input=0.75, output=4.50),
    'gpt-5.4-nano': ModelPrice(input=0.20, output=1.25),
    'gpt-5.3-codex': ModelPrice(input=1.75, output=14.00),
    # Deep research (batch rates). NOTE: these cover tokens only. Deep research
    # also attaches web_search_preview and code_interpreter, which bill
    # per-call on top, so the recorded figure is a floor for these operations —
    # not the whole bill.
    'o4-mini-deep-research': ModelPrice(input=1.00, output=4.00),
    'o3-deep-research': ModelPrice(input=5.00, output=20.00),
    # Retired, retained so historical replay and any straggler still price.
    'gpt-5.2': ModelPrice(input=0.88, output=7.00),
    'gpt-4.1': ModelPrice(input=2.00, output=8.00),
}

#: Operations whose recorded cost excludes per-call tool fees.
TOOL_AUGMENTED_OPERATIONS = frozenset({'research_selected_ideas', 'agent_research'})


@dataclass(frozen=True)
class TokenUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cached_input_tokens: int = 0
    reasoning_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


def extract_usage(response: Any) -> TokenUsage:
    """Pull token counts off an OpenAI Responses object.

    Defensive by design: this runs after a call the user has already been
    billed for, so a shape change in the SDK must degrade to zeros rather than
    raise. Zeros are visible in the logs as an anomaly; an exception here would
    discard a successful response.
    """
    usage = getattr(response, 'usage', None)
    if usage is None:
        return TokenUsage()

    def _int(value: Any) -> int:
        try:
            return int(value or 0)
        except (TypeError, ValueError):
            return 0

    # The Responses API uses input_tokens/output_tokens; Chat Completions used
    # prompt_tokens/completion_tokens. Accept either so a caller switching APIs
    # does not silently stop reporting.
    input_tokens = _int(getattr(usage, 'input_tokens', None) or getattr(usage, 'prompt_tokens', None))
    output_tokens = _int(getattr(usage, 'output_tokens', None) or getattr(usage, 'completion_tokens', None))
    cached = _int(getattr(getattr(usage, 'input_tokens_details', None), 'cached_tokens', None))
    reasoning = _int(getattr(getattr(usage, 'output_tokens_details', None), 'reasoning_tokens', None))

    return TokenUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cached_input_tokens=min(cached, input_tokens),
        reasoning_tokens=reasoning,
    )


def estimate_cost_usd(model: str, usage: TokenUsage) -> float | None:
    """Cost in USD for a call, or None when the model has no published price.

    Returning None rather than 0.0 for an unknown model matters: a zero would
    average into dashboards as "this model is free", quietly understating COGS
    for exactly the model nobody has priced yet.
    """
    price = MODEL_PRICING.get(model)
    if price is None:
        return None

    cached = usage.cached_input_tokens
    uncached = max(0, usage.input_tokens - cached)
    cached_rate = price.cached_input if price.cached_input is not None else price.input

    return (
        uncached * price.input / 1_000_000
        + cached * cached_rate / 1_000_000
        + usage.output_tokens * price.output / 1_000_000
    )


def record_llm_usage(
    table: Any,
    user_sub: str | None,
    *,
    model: str,
    operation: str,
    response: Any,
) -> TokenUsage:
    """Log and persist what a call consumed. Never raises.

    Returns the extracted usage so callers can assert on it in tests.
    """
    usage = extract_usage(response)
    cost = estimate_cost_usd(model, usage)

    log_fields = {
        'model': model,
        'operation': operation,
        'input_tokens': usage.input_tokens,
        'output_tokens': usage.output_tokens,
        'cached_input_tokens': usage.cached_input_tokens,
        'reasoning_tokens': usage.reasoning_tokens,
        'cost_usd': round(cost, 6) if cost is not None else None,
        # Flags the operations whose real bill exceeds the token cost.
        'excludes_tool_fees': operation in TOOL_AUGMENTED_OPERATIONS,
        'priced': cost is not None,
        # A background job (background=True) returns immediately with no usage;
        # the real consumption only exists once it completes. Marking those
        # rather than recording a zero keeps "not measured yet" distinguishable
        # from "measured, cost nothing".
        'deferred': usage.total_tokens == 0,
    }
    # Always the same message, so a CloudWatch filter on `llm_usage` catches
    # every call. An unpriced model is signalled by priced=false and the WARNING
    # level, not by a different message a filter would miss.
    if cost is None:
        logger.warning('llm_usage', extra=log_fields)
    else:
        logger.info('llm_usage', extra=log_fields)

    if table is None or not user_sub:
        return usage

    # Nothing was reported: a queued background job, or a response shape we
    # could not read. Writing callCount=1 with microUsd=0 would put a row that
    # reads as "this call was free" against the single most expensive operation
    # in the system, which is worse than recording nothing at all.
    if usage.total_tokens == 0:
        return usage

    # An unpriced model still gets its token volume recorded — the cost is what
    # is unknown, not the usage.
    micro_usd = int(round(cost * MICRO_USD)) if cost is not None else 0
    month = datetime.now(UTC).strftime('%Y-%m')
    try:
        table.update_item(
            Key={'PK': f'USER#{user_sub}', 'SK': f'USAGE#cost#monthly#{month}'},
            UpdateExpression=(
                'ADD microUsd :cost, inputTokens :inp, outputTokens :out, callCount :one '
                'SET #ttl = if_not_exists(#ttl, :ttl)'
            ),
            ExpressionAttributeNames={'#ttl': 'ttl'},
            ExpressionAttributeValues={
                ':cost': micro_usd,
                ':inp': usage.input_tokens,
                ':out': usage.output_tokens,
                ':one': 1,
                ':ttl': int(time.time()) + COST_TTL_SECONDS,
            },
        )
    except Exception:
        # Deliberately broad: metering must never fail a call the user has
        # already been billed for, so a throttle, a schema surprise, or a
        # credentials blip all degrade to a log line.
        logger.exception('Failed to record LLM cost for user %s (op=%s)', user_sub, operation)

    return usage
