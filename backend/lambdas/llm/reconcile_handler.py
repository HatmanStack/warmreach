"""Research Reconciler Lambda - persist completed deep-research jobs.

Deep research runs as an OpenAI ``background=True`` job. Persistence to the
profile normally depends on a live frontend poll (``get_research_result``); if
the browser refreshes/closes, the in-memory poll dies and a job OpenAI actually
completes is never mirrored to ``ai_generated_research``. This Lambda runs on an
EventBridge schedule, scans for in-progress ``RESEARCH#`` rows, and reconciles
them against OpenAI so results become durable regardless of the browser.

Safety guards (see docs/plan): a completed *old* job must not clobber the
profile's current research. So per user only the **newest** active job is
reconciled/mirrored, and any active job older than ``STALE_RESEARCH_HOURS`` is
marked ``abandoned`` without touching the profile.
"""

import logging
import os
import time
from collections import defaultdict
from datetime import UTC, datetime, timedelta

import boto3
from openai import OpenAI
from services.llm_service import (
    RESEARCH_RECON_PARTITION,
    STALE_RESEARCH_HOURS,
    LLMService,
    parse_iso_datetime,
)
from shared_services.handler_utils import parallel_scan
from shared_services.ssm_cache import SSMCachedSecret

logger = logging.getLogger()
logger.setLevel(logging.INFO)

OPENAI_TIMEOUT = int(os.environ.get('OPENAI_TIMEOUT', '60'))
_openai_secret = SSMCachedSecret(os.environ.get('OPENAI_API_KEY_ARN', ''))

table_name = os.environ.get('DYNAMODB_TABLE_NAME')
table = boto3.resource('dynamodb').Table(table_name) if table_name else None

# STALE_RESEARCH_HOURS is shared with get_active_research (imported from
# llm_service) so the on-demand and background paths retire zombies identically.

# LLMService rebuilt periodically so rotated OpenAI keys propagate (mirrors the
# LLM Lambda's pattern).
_service: LLMService | None = None
_service_created_at: float = 0.0
_SERVICE_TTL = 300  # 5 minutes


def _get_service() -> LLMService:
    global _service, _service_created_at
    now = time.time()
    if _service is None or (now - _service_created_at) > _SERVICE_TTL:
        client = OpenAI(api_key=_openai_secret.get_value(), timeout=OPENAI_TIMEOUT)
        _service = LLMService(openai_client=client, table=table)
        _service_created_at = now
    return _service


# One tick in twelve — hourly at rate(5 minutes) — also runs the old scan.
SWEEP_EVERY_N_TICKS = 12


def _query_active_research() -> list[dict]:
    """Read the in-flight research rows from the sparse GSI3.

    Replaces a filtered ``parallel_scan`` that read the entire table on every
    tick (1,152 scan calls/day at 4 segments x rate(5 minutes)), whose cost grew
    with the table rather than with the number of in-flight jobs. The query reads
    O(active jobs).
    """
    items: list[dict] = []
    params: dict = {
        'IndexName': 'GSI3',
        'KeyConditionExpression': 'GSI3PK = :pk',
        'ExpressionAttributeValues': {':pk': RESEARCH_RECON_PARTITION},
    }
    while True:
        resp = table.query(**params)
        items.extend(resp.get('Items', []))
        last = resp.get('LastEvaluatedKey')
        if not last:
            break
        params['ExclusiveStartKey'] = last
    return items


def _sweep_for_unindexed(indexed: list[dict]) -> list[dict]:
    """Scan for active rows the index missed, and say so loudly if there are any.

    A sparse index is only as good as the write paths that maintain it: a row
    that misses its GSI3 keys becomes permanently unreconcilable, and nothing
    would ever report it — the reconciler would just quietly stop seeing it.
    That is the same silent-failure shape the index is meant to remove, so it is
    worth paying for a periodic check rather than assuming.

    Two things make this cheap: it runs once an hour rather than every tick, and
    it should find nothing. A non-empty result is a bug in one of the write
    sites in ``llm_service.research_index_parts``, not a routine occurrence —
    hence ``logger.error``.

    Rows created before the index existed also surface here, which is what
    carries in-flight jobs across the deploy that introduces it.
    """
    seen = {(i.get('PK'), i.get('SK')) for i in indexed}
    found = parallel_scan(
        table,
        total_segments=4,
        scan_kwargs={
            'FilterExpression': 'begins_with(SK, :sk) AND (#s = :ip OR #s = :st)',
            'ExpressionAttributeNames': {'#s': 'status'},
            'ExpressionAttributeValues': {
                ':sk': 'RESEARCH#',
                ':ip': 'in_progress',
                ':st': 'starting',
            },
        },
    )
    missed = [i for i in found if (i.get('PK'), i.get('SK')) not in seen]
    if missed:
        logger.error(
            'GSI3 reconciliation index missed %d active research row(s) — a write path '
            'is not maintaining GSI3PK/GSI3SK (or these predate the index). Keys: %s',
            len(missed),
            [f'{i.get("PK")}/{i.get("SK")}' for i in missed[:10]],
        )
    return missed


def _should_sweep() -> bool:
    """Whether this tick also runs the index-verification sweep.

    Wall-clock derived so it needs no stored state, but kept as its own function
    so tests can pin it. Reading the clock inline would make every other test in
    this module behave differently between :00 and :05.
    """
    return datetime.now(UTC).minute < (60 // SWEEP_EVERY_N_TICKS)


def lambda_handler(event, _context):
    """Reconcile in-progress deep-research jobs against OpenAI."""
    if table is None:
        logger.error('DYNAMODB_TABLE_NAME not configured — reconciler is a no-op')
        return {
            'scanned': 0,
            'unindexed': 0,
            'reconciled': 0,
            'completed': 0,
            'abandoned': 0,
            'errors': 0,
        }

    svc = _get_service()

    items = _query_active_research()

    unindexed: list[dict] = []
    if _should_sweep():
        unindexed = _sweep_for_unindexed(items)
        items = items + unindexed

    by_user: dict[str, list[dict]] = defaultdict(list)
    for it in items:
        user_id = it.get('PK', '').replace('USER#', '')
        if user_id:
            by_user[user_id].append(it)

    cutoff = datetime.now(UTC) - timedelta(hours=STALE_RESEARCH_HOURS)
    scanned = len(items)
    reconciled = completed = abandoned = errors = 0

    for user_id, jobs in by_user.items():
        # Newest first: only the newest active job may reconcile/mirror; older
        # ones are superseded so a stale result can't clobber the profile.
        jobs.sort(key=lambda i: i.get('created_at', ''), reverse=True)

        for superseded in jobs[1:]:
            job_id = superseded['SK'].split('#', 1)[1]
            svc._set_research_status(user_id, job_id, 'abandoned')
            abandoned += 1

        primary = jobs[0]
        job_id = primary['SK'].split('#', 1)[1]

        created = parse_iso_datetime(primary.get('created_at'))
        if created is not None and created < cutoff:
            # Zombie: too old to still be running. Retire without mirroring.
            svc._set_research_status(user_id, job_id, 'abandoned')
            abandoned += 1
            continue

        response_id = primary.get('openai_response_id')
        if not response_id:
            # Still inside the kickoff window (row written, OpenAI job not yet
            # created). Nothing to reconcile; leave it for the next tick.
            continue

        try:
            # get_research_result reconciles the row against OpenAI and, on
            # completion, mirrors content to the profile (RESEARCH kind).
            result = svc.get_research_result(user_id, job_id, 'RESEARCH')
            reconciled += 1
            if result.get('success') and result.get('content'):
                completed += 1
        except Exception:
            errors += 1
            logger.exception('Reconcile failed for %s/%s', user_id, job_id)

    summary = {
        'scanned': scanned,
        # Should always be 0. Anything else means a write path stopped
        # maintaining the GSI3 keys — see _sweep_for_unindexed.
        'unindexed': len(unindexed),
        'reconciled': reconciled,
        'completed': completed,
        'abandoned': abandoned,
        'errors': errors,
    }
    logger.info('Research reconciler complete: %s', summary)
    return summary
