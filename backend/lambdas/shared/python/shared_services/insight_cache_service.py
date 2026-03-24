"""InsightCacheService stub for community edition.

All operations that use this service are behind pro feature gates and will
return 403 before reaching these methods. This stub exists only to satisfy
the import at Lambda cold-start.
"""


class InsightCacheService:
    """No-op stub. Pro edition replaces this with the caching implementation."""

    def __init__(self, table=None):
        pass

    def get_messaging_insights(self, user_id, edge_query_fn=None, force_recompute=False):
        return {}

    def store_message_insights(self, user_id, insights):
        return {}

    def compute_and_store_scores(
        self, user_id, edge_query_fn=None, scoring_service=None, profile_metadata_fn=None
    ):
        return {}

    def get_priority_recommendations(
        self, user_id, edge_query_fn=None, reply_prob_service=None, priority_service=None,
        limit=20, force_recompute=False
    ):
        return {}
