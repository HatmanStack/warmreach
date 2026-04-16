"""EdgeIngestionService - RAGStack ingestion triggers for user-profile edges."""

import logging
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from shared_services.base_service import BaseService

logger = logging.getLogger(__name__)

try:
    from utils.profile_markdown import generate_profile_markdown
except ImportError:
    generate_profile_markdown = None


class EdgeIngestionService(BaseService):
    """Manages RAGStack ingestion triggers for edges."""

    def __init__(
        self,
        table,
        ragstack_endpoint: str = '',
        ragstack_api_key: str = '',
        ragstack_client=None,
        ingestion_service=None,
    ):
        super().__init__()
        self.table = table
        self.ragstack_endpoint = ragstack_endpoint
        self.ragstack_api_key = ragstack_api_key
        self.ragstack_client = ragstack_client
        self.ingestion_service = ingestion_service

    def trigger_ragstack_ingestion(self, profile_id_b64: str, user_id: str) -> dict:
        """Trigger RAGStack ingestion for a profile via direct HTTP call."""
        if not self.ragstack_endpoint or not self.ragstack_api_key:
            logger.warning('RAGStack not configured, skipping ingestion')
            return {'success': False, 'error': 'RAGStack not configured'}

        if not self.ragstack_client or not self.ingestion_service:
            logger.warning('RAGStack client/ingestion service not injected, skipping ingestion')
            return {'success': False, 'error': 'RAGStack services not injected'}

        ingest_state = self._get_ingest_state(profile_id_b64)
        if ingest_state:
            logger.info('Skipping ingestion for %s: recently ingested', profile_id_b64)
            return {
                'success': True,
                'status': 'already_ingested',
                'documentId': ingest_state.get('document_id'),
            }

        try:
            profile_data = self._get_profile_metadata(profile_id_b64)
            if not profile_data:
                return {'success': False, 'error': 'Profile metadata not found'}

            profile_data['profile_id'] = profile_id_b64

            if generate_profile_markdown is None:
                logger.error('profile_markdown module not available')
                return {'success': False, 'error': 'Markdown generator module not available'}

            try:
                markdown_content = generate_profile_markdown(profile_data)
            except Exception as e:
                logger.error('Error generating markdown: %s', e)
                return {'success': False, 'error': f'Markdown generation failed: {e}'}

            result = self.ingestion_service.ingest_profile(
                profile_id=profile_id_b64,
                markdown_content=markdown_content,
                metadata={'user_id': user_id, 'source': 'edge_processing'},
            )

            if result.get('status') in ('uploaded', 'indexed', 'submitted'):
                self._update_ingest_state(profile_id_b64, result.get('documentId'))
                return {'success': True, 'status': result['status'], 'documentId': result.get('documentId')}
            else:
                return {'success': False, 'error': result.get('error', 'Ingestion failed')}

        except Exception as e:
            logger.error('Error triggering RAGStack ingestion: %s', e)
            return {'success': False, 'error': str(e)}

    def update_ingestion_flag(
        self, user_id: str, profile_id_b64: str, timestamp: str, document_id: str | None = None
    ) -> None:
        """Update edge with RAGStack ingestion status."""
        try:
            update_expr = 'SET ragstack_ingested = :ingested, ragstack_ingested_at = :ingested_at'
            attr_values: dict[str, Any] = {':ingested': True, ':ingested_at': timestamp}
            if document_id:
                update_expr += ', ragstack_document_id = :doc_id'
                attr_values[':doc_id'] = document_id
            self.table.update_item(
                Key={'PK': f'USER#{user_id}', 'SK': f'PROFILE#{profile_id_b64}'},
                UpdateExpression=update_expr,
                ExpressionAttributeValues=attr_values,
            )
        except Exception as e:
            logger.warning('Failed to update ingestion flag: %s', e)

    def is_recently_ingested(self, profile_id: str) -> bool:
        """Check if this profile has been ingested within 30 days."""
        return self._get_ingest_state(profile_id) is not None

    def _get_ingest_state(self, profile_id: str) -> dict | None:
        """Get the ingest state for a profile if ingested within 30 days."""
        try:
            response = self.table.get_item(
                Key={'PK': f'PROFILE#{profile_id}', 'SK': '#INGEST_STATE'},
            )
            item = response.get('Item')
            if not item:
                return None

            ingested_at_str = item.get('ingested_at', '')
            if not ingested_at_str:
                return None

            thirty_days_ago = datetime.now(UTC) - timedelta(days=30)
            try:
                ingested_at = datetime.fromisoformat(ingested_at_str.replace('Z', '+00:00'))
                if ingested_at > thirty_days_ago:
                    return item
                return None
            except (ValueError, TypeError):
                return None
        except Exception as e:
            logger.warning('Failed to check ingestion dedup for %s: %s', profile_id, e)
            return None

    def _update_ingest_state(self, profile_id: str, document_id: str | None = None) -> None:
        """Write a shared dedup marker at PROFILE#{id}|#INGEST_STATE with 35-day TTL."""
        try:
            timestamp = datetime.now(UTC).isoformat()
            ttl = int(time.time()) + (35 * 24 * 3600)
            update_expr = 'SET ingested_at = :ts, #ttl = :ttl'
            attr_names: dict[str, str] = {'#ttl': 'ttl'}
            attr_values: dict[str, Any] = {':ts': timestamp, ':ttl': ttl}
            if document_id:
                update_expr += ', document_id = :doc_id'
                attr_values[':doc_id'] = document_id
            self.table.update_item(
                Key={'PK': f'PROFILE#{profile_id}', 'SK': '#INGEST_STATE'},
                UpdateExpression=update_expr,
                ExpressionAttributeNames=attr_names,
                ExpressionAttributeValues=attr_values,
            )
        except Exception as e:
            logger.warning('Failed to update ingest state for %s: %s', profile_id, e)

    def _get_profile_metadata(self, profile_id: str) -> dict:
        """Fetch profile metadata from DynamoDB."""
        try:
            response = self.table.get_item(Key={'PK': f'PROFILE#{profile_id}', 'SK': '#METADATA'})
            return response.get('Item', {})
        except Exception as e:
            logger.warning('Failed to fetch profile metadata: %s', e)
            return {}
