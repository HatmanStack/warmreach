"""EdgeService - Facade over decomposed edge services.

Deprecated: use EdgeDataService directly. This facade exists only for backward
compatibility with existing tests. No production code imports EdgeService;
lambda_function.py uses EdgeDataService, InsightCacheService, and
RAGStackProxyService directly.

Inherits EdgeDataService (CRUD). Insight/scoring and RAGStack proxy operations
are now handled by InsightCacheService and RAGStackProxyService respectively.
"""

import logging

from shared_services.edge_data_service import EdgeDataService
from shared_services.message_intelligence_service import MessageIntelligenceService
from shared_services.priority_inference_service import PriorityInferenceService
from shared_services.relationship_scoring_service import RelationshipScoringService
from shared_services.reply_probability_service import ReplyProbabilityService

logger = logging.getLogger(__name__)


class EdgeService(EdgeDataService):
    """Deprecated: use EdgeDataService directly. This facade exists only for backward compatibility.

    Inherits CRUD operations from EdgeDataService. Insight caching,
    relationship scoring, and RAGStack proxy operations are handled by
    InsightCacheService and RAGStackProxyService.
    """

    def __init__(
        self,
        table,
        ragstack_endpoint: str = '',
        ragstack_api_key: str = '',
        ragstack_client=None,
        ingestion_service=None,
        priority_inference_service=None,
        reply_probability_service=None,
    ):
        super().__init__(
            table=table,
            ragstack_endpoint=ragstack_endpoint,
            ragstack_api_key=ragstack_api_key,
            ragstack_client=ragstack_client,
            ingestion_service=ingestion_service,
        )
        self.scoring_service = RelationshipScoringService()
        self.message_intelligence_service = MessageIntelligenceService()
        self.priority_inference_service = priority_inference_service or PriorityInferenceService()
        self.reply_probability_service = reply_probability_service or ReplyProbabilityService()
