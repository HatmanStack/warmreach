"""EdgeDataService - Thin facade over focused edge sub-services.

Module-level constants and encode_profile_id are re-exported from
edge_constants for backward compatibility. All external consumers and
sub-services can continue importing from this module.
"""

import logging
from typing import Any

from shared_services.base_service import BaseService
from shared_services.dynamodb_types import ProfileMetadataItem
from shared_services.edge_constants import (  # noqa: F401
    INGESTION_TRIGGER_STATUSES,
    MAX_MESSAGES_PER_EDGE,
    MAX_NOTE_LENGTH,
    MAX_NOTES_PER_EDGE,
    OPPORTUNITY_OUTCOMES,
    OPPORTUNITY_STAGES,
    encode_profile_id,
)
from shared_services.edge_ingestion_service import EdgeIngestionService
from shared_services.edge_message_service import EdgeMessageService
from shared_services.edge_note_service import EdgeNoteService
from shared_services.edge_opportunity_service import EdgeOpportunityService
from shared_services.edge_query_service import EdgeQueryService
from shared_services.edge_status_service import EdgeStatusService

logger = logging.getLogger(__name__)


class EdgeDataService(BaseService):
    """Facade that delegates to focused edge sub-services.

    The public API is identical to the original monolithic class. All consumers
    continue importing from this module without changes.
    """

    def __init__(
        self,
        table,
        ragstack_endpoint: str = '',
        ragstack_api_key: str = '',
        ragstack_client=None,
        ingestion_service=None,
        dynamodb_client=None,
    ):
        super().__init__()
        self.table = table
        self.ragstack_endpoint = ragstack_endpoint
        self.ragstack_api_key = ragstack_api_key
        self.ragstack_client = ragstack_client
        self.ingestion_service = ingestion_service

        self._ingestion_svc = EdgeIngestionService(
            table, ragstack_endpoint, ragstack_api_key, ragstack_client, ingestion_service
        )
        self._status_svc = EdgeStatusService(table, self._ingestion_svc, dynamodb_client)
        self._messages_svc = EdgeMessageService(table)
        self._notes_svc = EdgeNoteService(table)
        self._queries_svc = EdgeQueryService(table)
        self._opportunity_svc = EdgeOpportunityService(table, self._queries_svc)

    # ---- Status operations (delegated to EdgeStatusService) ----

    def upsert_status(
        self, user_id: str, profile_id: str, status: str, added_at: str | None = None, messages: list | None = None
    ) -> dict[str, Any]:
        return self._status_svc.upsert_status(user_id, profile_id, status, added_at, messages)

    # ---- Message operations (delegated to EdgeMessageService) ----

    def add_message(
        self, user_id: str, profile_id: str, message: str, message_type: str = 'outbound'
    ) -> dict[str, Any]:
        return self._messages_svc.add_message(user_id, profile_id, message, message_type)

    def update_messages(self, user_id: str, profile_id: str, messages: list) -> dict[str, Any]:
        return self._messages_svc.update_messages(user_id, profile_id, messages)

    def get_messages(self, user_id: str, profile_id: str) -> dict[str, Any]:
        return self._messages_svc.get_messages(user_id, profile_id)

    # ---- Note operations (delegated to EdgeNoteService) ----

    def add_note(self, user_id: str, profile_id: str, content: str) -> dict[str, Any]:
        return self._notes_svc.add_note(user_id, profile_id, content)

    def update_note(self, user_id: str, profile_id: str, note_id: str, content: str) -> dict[str, Any]:
        return self._notes_svc.update_note(user_id, profile_id, note_id, content)

    def delete_note(self, user_id: str, profile_id: str, note_id: str) -> dict[str, Any]:
        return self._notes_svc.delete_note(user_id, profile_id, note_id)

    # ---- Query operations (delegated to EdgeQueryService) ----

    def get_connections_by_status(self, user_id: str, status: str | None = None) -> dict[str, Any]:
        return self._queries_svc.get_connections_by_status(user_id, status)

    def check_exists(self, user_id: str, profile_id: str) -> dict[str, Any]:
        return self._queries_svc.check_exists(user_id, profile_id)

    def query_all_edges(self, user_id: str) -> list[dict]:
        return self._queries_svc.query_all_edges(user_id)

    def get_profile_metadata(self, profile_id: str) -> ProfileMetadataItem:
        return self._queries_svc.get_profile_metadata(profile_id)

    def batch_get_profile_metadata(self, profile_ids: list[str]) -> dict[str, ProfileMetadataItem]:
        return self._queries_svc.batch_get_profile_metadata(profile_ids)

    # ---- Ingestion operations (delegated to EdgeIngestionService) ----

    def is_recently_ingested(self, profile_id: str) -> bool:
        return self._ingestion_svc.is_recently_ingested(profile_id)

    def _trigger_ragstack_ingestion(self, profile_id_b64: str, user_id: str) -> dict:
        return self._ingestion_svc.trigger_ragstack_ingestion(profile_id_b64, user_id)

    def _update_ingestion_flag(
        self, user_id: str, profile_id_b64: str, timestamp: str, document_id: str | None = None
    ) -> None:
        return self._ingestion_svc.update_ingestion_flag(user_id, profile_id_b64, timestamp, document_id)

    # ---- Opportunity operations (delegated to EdgeOpportunityService) ----

    def tag_connection_to_opportunity(
        self, user_id: str, profile_id: str, opportunity_id: str, stage: str = 'identified'
    ) -> dict[str, Any]:
        return self._opportunity_svc.tag_connection_to_opportunity(user_id, profile_id, opportunity_id, stage)

    def untag_connection_from_opportunity(self, user_id: str, profile_id: str, opportunity_id: str) -> dict[str, Any]:
        return self._opportunity_svc.untag_connection_from_opportunity(user_id, profile_id, opportunity_id)

    def update_connection_stage(
        self, user_id: str, profile_id: str, opportunity_id: str, new_stage: str
    ) -> dict[str, Any]:
        return self._opportunity_svc.update_connection_stage(user_id, profile_id, opportunity_id, new_stage)

    def get_opportunity_connections(self, user_id: str, opportunity_id: str) -> dict[str, Any]:
        return self._opportunity_svc.get_opportunity_connections(user_id, opportunity_id)
