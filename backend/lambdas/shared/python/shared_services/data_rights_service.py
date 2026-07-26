"""Data subject rights: export and erasure (GDPR Art. 15 / 17, CCPA).

The product stores LLM-generated inferences — relationship scores, reply
probabilities, influence rankings — about third parties who never consented,
alongside the account holder's own data. Neither an export nor a deletion path
existed, so that liability grew with every signup and every account that could
not be closed.

Scope of "the user's data" is deliberately drawn at ``PK = USER#{sub}``, which
holds settings, tier, usage counters, connection edges (and the inferences on
them), notifications, opportunities, comment drafts, agent state and the
adjacency mesh — plus the ``STRIPE#{customer}`` mapping, which is keyed by
customer id but is unambiguously personal data.

Deliberately *not* included: ``PROFILE#{id} / #METADATA`` and ``#INGEST_STATE``.
Those are scraped third-party profile records shared across every user who has
that connection, so deleting them on one account's erasure would silently
destroy other users' data. They need a separate retention sweep that removes a
profile once no user references it — see :func:`orphaned_profile_note`.
"""

import json
import logging
from datetime import UTC, datetime
from typing import Any

from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

#: DynamoDB caps BatchWriteItem at 25 requests.
BATCH_DELETE_SIZE = 25

#: Sweeps to attempt before giving up. Each pass re-enumerates, so this bounds
#: the case where something keeps writing to a partition being erased — better
#: to report incomplete than to spin forever.
MAX_DELETE_PASSES = 5

#: Sort-key prefixes that are the account holder's own data. Recorded
#: explicitly rather than "everything under the PK" so a future entity type is
#: a deliberate decision — a new SK that nobody adds here shows up in the
#: unclassified count rather than being silently exported or silently kept.
KNOWN_SK_PREFIXES = (
    '#SETTINGS',
    'TIER#',
    'USAGE#',
    'PROFILE#',
    'NOTIFICATION#',
    'OPPORTUNITY#',
    'COMMENT_DRAFT#',
    'FEEDBACK#',
    'ACTIVITY#',
    'ADJ#',
    'ACTION#',
    'AGENTCFG#',
    'AGENTASSESS#',
    'AGENTRESEARCH#',
    'AGENTRESEARCHBUDGET#',
    'INSIGHTS#',
    'STATUS#',
    'RESEARCH#',
    'COMMAND#',
    'RATELIMIT#',
)


def _classify(sk: str) -> str:
    """Bucket a sort key by entity type, for the export manifest."""
    for prefix in KNOWN_SK_PREFIXES:
        if sk.startswith(prefix):
            return prefix.rstrip('#') or prefix
    return 'other'


class DataRightsService:
    """Export and erasure for a single account."""

    def __init__(self, table):
        self.table = table

    def _iter_user_items(self, user_sub: str):
        """Yield every item stored under this user's partition."""
        kwargs: dict[str, Any] = {
            'KeyConditionExpression': 'PK = :pk',
            'ExpressionAttributeValues': {':pk': f'USER#{user_sub}'},
        }
        while True:
            resp = self.table.query(**kwargs)
            yield from resp.get('Items', [])
            last = resp.get('LastEvaluatedKey')
            if not last:
                return
            kwargs['ExclusiveStartKey'] = last

    def _stripe_mapping_items(self, user_sub: str) -> list[dict]:
        """Locate the STRIPE#{customer} mapping for this user via GSI1.

        Keyed by customer id rather than user, so it is invisible to the
        partition query above and would survive an otherwise complete erasure —
        and be missing from an otherwise complete export.
        """
        try:
            resp = self.table.query(
                IndexName='GSI1',
                KeyConditionExpression='GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
                ExpressionAttributeValues={':pk': f'USER#{user_sub}', ':sk': 'STRIPE#'},
            )
        except ClientError:
            # A missing GSI must not abort an erasure; the rest still proceeds
            # and the shortfall is reported.
            logger.exception('Could not query GSI1 for Stripe mapping of %s', user_sub)
            return []
        return list(resp.get('Items', []))

    def _stripe_mapping_keys(self, user_sub: str) -> list[dict]:
        """Just the keys of the Stripe mapping, for deletion."""
        return [{'PK': i['PK'], 'SK': i['SK']} for i in self._stripe_mapping_items(user_sub) if 'PK' in i and 'SK' in i]

    def export_user_data(self, user_sub: str) -> dict[str, Any]:
        """Return everything held about this account, as a JSON-ready dict.

        Includes a per-entity-type count so the subject can see the shape of
        what is held without reading every record, and an explicit note about
        what is excluded and why.
        """
        items: list[dict] = []
        counts: dict[str, int] = {}
        for item in self._iter_user_items(user_sub):
            items.append(item)
            bucket = _classify(str(item.get('SK', '')))
            counts[bucket] = counts.get(bucket, 0) + 1

        # The Stripe mapping lives outside the user's partition but is
        # unambiguously personal data — erasure removes it, so an export that
        # omitted it would disclose less than the deletion destroys.
        for item in self._stripe_mapping_items(user_sub):
            items.append(item)
            counts['STRIPE'] = counts.get('STRIPE', 0) + 1

        return {
            'exportedAt': datetime.now(UTC).isoformat(),
            'userId': user_sub,
            'itemCount': len(items),
            'countsByType': counts,
            'items': items,
            'notIncluded': orphaned_profile_note(),
        }

    def _delete_keys(self, user_sub: str, keys: list[dict]) -> tuple[int, int]:
        """Batch-delete a key list. Returns (deleted, failed)."""
        deleted = failed = 0
        for start in range(0, len(keys), BATCH_DELETE_SIZE):
            batch = keys[start : start + BATCH_DELETE_SIZE]
            try:
                with self.table.batch_writer() as writer:
                    for key in batch:
                        writer.delete_item(Key=key)
                deleted += len(batch)
            except ClientError:
                logger.exception('Batch delete failed for %s (%d keys)', user_sub, len(batch))
                failed += len(batch)
        return deleted, failed

    def _collect_keys(self, user_sub: str) -> list[dict]:
        keys = [
            {'PK': item['PK'], 'SK': item['SK']}
            for item in self._iter_user_items(user_sub)
            if 'PK' in item and 'SK' in item
        ]
        keys.extend(self._stripe_mapping_keys(user_sub))
        return keys

    def delete_user_data(self, user_sub: str) -> dict[str, Any]:
        """Erase the account's data. Returns a report of what was removed.

        Not transactional: DynamoDB offers no cross-partition transaction at
        this size, so a failure part-way leaves the remainder deleted and
        reports the shortfall. Erasure is idempotent — re-running finishes the
        job — which matters more than atomicity here.

        Enumerate-then-delete has a race: anything written to the partition
        after enumeration (a concurrent quota counter, a notification, a
        scheduled job touching the account) would not be in the key list and
        would survive, while the report still said complete. So the sweep
        repeats until a pass finds nothing left, and reports ``complete: false``
        if it hits the bound with data still present — an erasure that quietly
        leaves data behind is the exact failure this module exists to prevent.
        """
        deleted = 0
        failed = 0
        passes = 0

        for _ in range(MAX_DELETE_PASSES):
            keys = self._collect_keys(user_sub)
            if not keys:
                break
            passes += 1
            batch_deleted, batch_failed = self._delete_keys(user_sub, keys)
            deleted += batch_deleted
            failed += batch_failed
            if batch_failed:
                # A hard failure will not resolve by looping; stop and report.
                break

        remaining = len(self._collect_keys(user_sub))
        complete = failed == 0 and remaining == 0

        report = {
            'userId': user_sub,
            'deletedAt': datetime.now(UTC).isoformat(),
            'deleted': deleted,
            'failed': failed,
            'remaining': remaining,
            'passes': passes,
            'complete': complete,
        }
        if not complete:
            logger.error(
                'Erasure incomplete for %s: %d deleted, %d failed, %d still present after %d passes',
                user_sub,
                deleted,
                failed,
                remaining,
                passes,
            )
        else:
            logger.info('Erasure complete for %s: %d items in %d passes', user_sub, deleted, passes)
        return report


def orphaned_profile_note() -> dict[str, str]:
    """Explain what an export/erasure does not cover, and why."""
    return {
        'sharedProfileRecords': (
            'Scraped LinkedIn profile records (PROFILE#{id}) are shared across every '
            'user connected to that person, so they are neither exported as your data '
            "nor deleted with your account — doing so would destroy other users' data. "
            'They contain no information about you. A separate retention sweep removes '
            'a profile once no account references it.'
        ),
    }


def to_json(payload: dict[str, Any]) -> str:
    """Serialise an export, coercing DynamoDB Decimals to plain numbers."""
    from decimal import Decimal

    def _default(value):
        if isinstance(value, Decimal):
            # Preserve integers as ints so counters do not export as "5.0".
            return int(value) if value == value.to_integral_value() else float(value)
        if isinstance(value, set):
            return sorted(value)
        return str(value)

    return json.dumps(payload, default=_default, indent=2)
