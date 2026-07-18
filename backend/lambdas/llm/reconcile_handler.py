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
from services.llm_service import STALE_RESEARCH_HOURS, LLMService, parse_iso_datetime
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


def lambda_handler(event, _context):
    """Reconcile in-progress deep-research jobs against OpenAI."""
    if table is None:
        logger.error('DYNAMODB_TABLE_NAME not configured — reconciler is a no-op')
        return {'scanned': 0, 'reconciled': 0, 'completed': 0, 'abandoned': 0, 'errors': 0}

    svc = _get_service()

    items = parallel_scan(
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
        'reconciled': reconciled,
        'completed': completed,
        'abandoned': abandoned,
        'errors': errors,
    }
    logger.info('Research reconciler complete: %s', summary)
    return summary
