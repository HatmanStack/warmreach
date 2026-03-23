"""RAGStackProxyService - RAGStack search, ingest, and status operations."""

import logging
from typing import Any

from errors.exceptions import ExternalServiceError
from shared_services.base_service import BaseService
from shared_services.edge_data_service import EdgeDataService, encode_profile_id

logger = logging.getLogger(__name__)


class RAGStackProxyService(BaseService):
    """Proxy service for RAGStack operations."""

    def __init__(self, ragstack_client=None, ingestion_service=None, table=None, edge_data_service=None):
        super().__init__()
        self.ragstack_client = ragstack_client
        self.ingestion_service = ingestion_service
        self.table = table
        self._edge_data_service = edge_data_service or (EdgeDataService(table=table) if table else None)

    def is_configured(self) -> bool:
        """Return True if the RAGStack client is available and configured."""
        return self.ragstack_client is not None

    def ragstack_search(self, query: str, max_results: int = 100) -> dict[str, Any]:
        """Search RAGStack for matching profiles."""
        if not self.ragstack_client:
            raise ExternalServiceError(
                message='RAGStack not configured',
                service='RAGStack',
            )
        results = self.ragstack_client.search(query, max_results)
        return {'results': results, 'totalResults': len(results)}

    def ragstack_ingest(
        self,
        profile_id: str,
        markdown_content: str,
        metadata: dict[str, Any],
        user_id: str,
    ) -> dict[str, Any]:
        """Ingest a profile document into RAGStack.

        Checks cross-user dedup before ingesting.

        Args:
            profile_id: Raw LinkedIn profile URL (e.g. "https://linkedin.com/in/jane").
        """
        if not self.ingestion_service:
            raise ExternalServiceError(
                message='RAGStack not configured',
                service='RAGStack',
            )

        profile_id_b64 = encode_profile_id(profile_id)
        if self._edge_data_service and self._is_recently_ingested(profile_id_b64):
            logger.info(f'Skipping ingestion for {profile_id}: recently ingested by another user')
            return {'status': 'skipped', 'reason': 'recently_ingested', 'profileId': profile_id}

        metadata = {**metadata, 'user_id': user_id}
        return self.ingestion_service.ingest_profile(profile_id_b64, markdown_content, metadata)

    def ragstack_status(self, document_id: str) -> dict[str, Any]:
        """Get ingestion status for a document."""
        if not self.ragstack_client:
            raise ExternalServiceError(
                message='RAGStack not configured',
                service='RAGStack',
            )
        return self.ragstack_client.get_document_status(document_id)

    def _is_recently_ingested(self, profile_id: str) -> bool:
        """Check if this profile has been ingested within 30 days.

        Delegates to EdgeDataService.is_recently_ingested to avoid duplicating
        the dedup/ingestion-recency check logic.
        """
        if not self._edge_data_service:
            return False
        return self._edge_data_service.is_recently_ingested(profile_id)
