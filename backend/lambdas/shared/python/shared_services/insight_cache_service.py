"""InsightCacheService - Insight caching with deduplicated 7-day TTL pattern."""

import logging
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from botocore.exceptions import ClientError
from errors.exceptions import ExternalServiceError, ValidationError
from shared_services.base_service import BaseService
from shared_services.message_intelligence_service import MessageIntelligenceService

logger = logging.getLogger(__name__)


class InsightCacheService(BaseService):
    """Service for caching and retrieving computed insights."""

    def __init__(self, table):
        super().__init__()
        self.table = table
        self.message_intelligence_service = MessageIntelligenceService()

    def _get_cached_or_compute(
        self,
        user_id: str,
        cache_sk: str,
        compute_fn: Callable[[], dict],
        format_cached_fn: Callable[[dict], dict],
        ttl_days: int = 7,
        force_recompute: bool = False,
    ) -> dict:
        """Generic cache-or-compute helper with TTL validation.

        Args:
            user_id: Cognito user sub.
            cache_sk: Sort key for the cached item (e.g., 'INSIGHTS#messaging').
            compute_fn: Callable that returns new data dict to store.
            format_cached_fn: Callable that formats a cached DynamoDB item for return.
            ttl_days: Cache TTL in days (default 7).
            force_recompute: Skip cache check entirely.

        Returns:
            dict with result data.
        """
        if not force_recompute:
            cached = self.table.get_item(Key={'PK': f'USER#{user_id}', 'SK': cache_sk}).get('Item')
            if cached:
                computed_at = cached.get('computedAt', '')
                if computed_at:
                    try:
                        computed_dt = datetime.fromisoformat(computed_at.replace('Z', '+00:00'))
                        age_days = (datetime.now(UTC) - computed_dt).total_seconds() / 86400
                        if age_days < ttl_days:
                            return format_cached_fn(cached)
                    except (ValueError, TypeError):
                        pass  # Recompute on parse failure

        result = compute_fn()

        now = datetime.now(UTC).isoformat()
        ttl = int(time.time()) + (ttl_days * 86400)

        item = {
            'PK': f'USER#{user_id}',
            'SK': cache_sk,
            'computedAt': now,
            'ttl': ttl,
        }
        item.update(result)

        self.table.put_item(Item=item)

        # Include the stored computedAt in the result so callers don't
        # need to create a second datetime.now() call
        result['computedAt'] = now

        return result

    def get_messaging_insights(
        self,
        user_id: str,
        edge_query_fn: Callable[[str], list[dict]],
        force_recompute: bool = False,
    ) -> dict[str, Any]:
        """Retrieve or compute messaging insights for a user.

        Args:
            user_id: Cognito user sub.
            edge_query_fn: Callable accepting user_id, returning list of edge dicts.
            force_recompute: Skip cache.
        """

        def _compute():
            edges = edge_query_fn(user_id)
            stats = self.message_intelligence_service.compute_messaging_stats(edges)
            sample_messages = self._collect_sample_outbound(edges, limit=10)
            return {
                'stats': stats,
                'sampleMessages': sample_messages,
            }

        def _format_cached(cached):
            return {
                'stats': cached.get('stats', {}),
                'insights': cached.get('insights'),
                'sampleMessages': cached.get('sampleMessages', []),
                'computedAt': cached.get('computedAt', ''),
            }

        result = self._get_cached_or_compute(
            user_id,
            'INSIGHTS#messaging',
            _compute,
            _format_cached,
            force_recompute=force_recompute,
        )

        # Add missing keys for fresh computation
        if 'insights' not in result:
            result['insights'] = None

        return result

    def store_message_insights(self, user_id: str, insights: list[str]) -> dict[str, Any]:
        """Store LLM-generated insights alongside cached stats."""
        try:
            now = datetime.now(UTC).isoformat()
            self.table.update_item(
                Key={'PK': f'USER#{user_id}', 'SK': 'INSIGHTS#messaging'},
                UpdateExpression='SET insights = :ins, insightsUpdatedAt = :ts',
                ConditionExpression='attribute_exists(PK)',
                ExpressionAttributeValues={
                    ':ins': insights,
                    ':ts': now,
                },
            )
            return {'success': True, 'insightsUpdatedAt': now}

        except ClientError as e:
            if e.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
                raise ValidationError(
                    'Messaging insights must be computed before storing LLM analysis',
                    field='insights',
                ) from None
            logger.error(f'DynamoDB error in store_message_insights: {e}')
            raise ExternalServiceError(
                message='Failed to store message insights', service='DynamoDB', original_error=str(e)
            ) from e

    def get_priority_recommendations(
        self,
        user_id: str,
        edge_query_fn: Callable[[str], list[dict]],
        reply_prob_service,
        priority_service,
        limit: int = 20,
        force_recompute: bool = False,
    ) -> dict[str, Any]:
        """Retrieve or compute priority recommendations for a user."""

        def _compute():
            edges = edge_query_fn(user_id)
            reply_probs = reply_prob_service.compute_reply_probabilities(edges)
            reply_prob_map = {r['profileId']: r for r in reply_probs}
            cache_limit = max(limit, 50)
            result = priority_service.compute_priority_recommendations(
                edges, reply_probabilities=reply_prob_map, limit=cache_limit
            )
            return {
                'recommendations': result['recommendations'],
                'totalEligible': result['totalEligible'],
            }

        def _format_cached(cached):
            recs = cached.get('recommendations', [])
            return {
                'recommendations': recs[:limit],
                'generatedAt': cached.get('computedAt', ''),
                'totalEligible': cached.get('totalEligible', 0),
            }

        result = self._get_cached_or_compute(
            user_id,
            'INSIGHTS#priority',
            _compute,
            _format_cached,
            force_recompute=force_recompute,
        )

        # Format fresh results to match cached format
        if 'generatedAt' not in result:
            result['generatedAt'] = result['computedAt']
        if 'recommendations' in result:
            result['recommendations'] = result['recommendations'][:limit]

        return result

    def compute_and_store_scores(
        self,
        user_id: str,
        edge_query_fn: Callable[[str], list[dict]],
        scoring_service,
        profile_metadata_fn: Callable[[str], dict],
    ) -> dict[str, Any]:
        """Compute relationship scores for all user connections and persist them."""
        try:
            edges = edge_query_fn(user_id)

            count = 0
            now = datetime.now(UTC).isoformat()
            # O(connections) individual updates — BatchWriteItem doesn't support UpdateExpression
            for edge in edges:
                profile_id = edge['SK'].replace('PROFILE#', '')
                metadata = profile_metadata_fn(profile_id)
                result = scoring_service.compute_score(edge, metadata)

                self.table.update_item(
                    Key={'PK': edge['PK'], 'SK': edge['SK']},
                    UpdateExpression='SET relationshipScore = :score, scoreBreakdown = :breakdown, scoreComputedAt = :ts',
                    ExpressionAttributeValues={
                        ':score': result['score'],
                        ':breakdown': result['breakdown'],
                        ':ts': now,
                    },
                )
                count += 1

            return {'success': True, 'scoresComputed': count}

        except ClientError as e:
            logger.error(f'DynamoDB error in compute_and_store_scores: {e}')
            raise ExternalServiceError(
                message='Failed to compute scores', service='DynamoDB', original_error=str(e)
            ) from e

    def _collect_sample_outbound(self, edges: list[dict], limit: int = 10) -> list[dict]:
        """Collect recent outbound messages across connections for LLM analysis."""
        candidates: list[dict] = []
        for edge in edges:
            messages = edge.get('messages', [])
            if not isinstance(messages, list):
                continue
            for msg in reversed(messages):
                if isinstance(msg, dict) and msg.get('type') == 'outbound' and msg.get('content'):
                    candidates.append({'content': msg['content'], 'timestamp': msg.get('timestamp', '')})
                    break
        candidates.sort(key=lambda m: m.get('timestamp', ''), reverse=True)
        return candidates[:limit]
