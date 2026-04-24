"""
Profile Ingestion Service

Uploads profile markdown documents to RAGStack for indexing.
Returns immediately with status:'submitted' after upload (fire-and-forget).
Callers check completion via the ragstack status operation.
"""

import logging
import time
from datetime import UTC, datetime
from typing import Any

import requests
import yaml
from shared_services.ragstack_client import RAGStackClient, RAGStackError

logger = logging.getLogger(__name__)


class IngestionError(Exception):
    """Base exception for ingestion errors"""

    pass


class UploadError(IngestionError):
    """Error during S3 upload"""

    pass


class IngestionService:
    """
    Service for ingesting profile documents into RAGStack.

    Handles:
    - Creating presigned upload URLs
    - Uploading markdown content to S3
    - Tracking ingestion status
    - Idempotent profile updates
    """

    def __init__(
        self,
        ragstack_client: RAGStackClient,
        max_upload_retries: int = 2,
        upload_retry_delay: float = 0.3,
    ):
        """
        Initialize ingestion service.

        Args:
            ragstack_client: Configured RAGStack client instance
            max_upload_retries: Maximum retries for S3 upload failures
            upload_retry_delay: Base delay between upload retries
        """
        self.client = ragstack_client
        self.max_upload_retries = max_upload_retries
        self.upload_retry_delay = upload_retry_delay

    def ingest_profile(
        self,
        profile_id: str,
        markdown_content: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Ingest a profile document into RAGStack (fire-and-forget).

        Uploads the document and returns immediately with status:'submitted'.
        Callers should check completion via the ragstack status operation.

        Args:
            profile_id: Unique profile identifier (base64 encoded LinkedIn URL)
            markdown_content: Profile content in markdown format
            metadata: Optional metadata to attach (user_id, source, etc.)

        Returns:
            Dict containing:
            - status: "submitted" or "failed"
            - documentId: The RAGStack document ID
            - error: Error message if status is "failed"
        """
        if not profile_id:
            raise ValueError('profile_id is required')
        if not markdown_content:
            raise ValueError('markdown_content is required')

        # Use profile_id as filename for idempotent uploads
        filename = f'{profile_id}.md'

        try:
            # Get presigned upload URL
            logger.info('Creating upload URL for profile %s', profile_id)
            upload_data = self.client.create_upload_url(filename)

            upload_url = upload_data['uploadUrl']
            document_id = upload_data['documentId']
            fields = upload_data.get('fields', {})

            # Prepare content with metadata header if provided
            content_with_metadata = self._prepare_content(markdown_content, metadata, profile_id)

            # Upload to S3
            logger.info('Uploading profile %s to S3', profile_id)
            self._upload_to_s3(upload_url, fields, content_with_metadata)

            logger.info('Profile %s submitted for ingestion', profile_id)
            return {
                'status': 'submitted',
                'documentId': document_id,
                'profileId': profile_id,
                'error': None,
            }

        except RAGStackError as e:
            logger.error('RAGStack error during ingestion: %s', e)
            return {
                'status': 'failed',
                'documentId': None,
                'profileId': profile_id,
                'error': str(e),
            }
        except UploadError as e:
            logger.error('Upload error during ingestion: %s', e)
            return {
                'status': 'failed',
                'documentId': None,
                'profileId': profile_id,
                'error': str(e),
            }
        except Exception as e:
            logger.error('Unexpected error during ingestion: %s', e)
            return {
                'status': 'failed',
                'documentId': None,
                'profileId': profile_id,
                'error': str(e),
            }

    def _prepare_content(
        self,
        markdown_content: str,
        metadata: dict[str, Any] | None,
        profile_id: str,
    ) -> str:
        """
        Prepare content with metadata header.

        Args:
            markdown_content: Original markdown content
            metadata: Optional metadata dict
            profile_id: Profile identifier

        Returns:
            Content with YAML frontmatter if metadata provided
        """
        if not metadata:
            return markdown_content

        # Add standard metadata
        full_metadata = {
            'profile_id': profile_id,
            'ingested_at': datetime.now(UTC).isoformat(),
            'source': 'linkedin_profile',
            **metadata,
        }

        # Create YAML frontmatter using safe_dump to properly escape special characters
        frontmatter = yaml.safe_dump(full_metadata, default_flow_style=False, allow_unicode=True, sort_keys=False)
        return f'---\n{frontmatter}---\n\n{markdown_content}'

    def _upload_to_s3(
        self,
        presigned_url: str,
        fields: dict[str, Any],
        content: str,
    ) -> None:
        """
        Upload content to S3 via presigned URL.

        Synchronous retry in Lambda. Max block time: ~0.9 seconds (2 retries with exponential backoff).
        WARNING: time.sleep() blocks the Lambda execution thread. See ADR-003.
        Consider Step Functions for long-running operations.

        Args:
            presigned_url: Presigned S3 URL
            fields: Additional form fields for multipart upload (if any)
            content: Content to upload

        Raises:
            UploadError: If upload fails after retries
        """
        last_error = None

        for attempt in range(self.max_upload_retries):
            try:
                # Handle both PUT-style and POST multipart presigned URLs
                if fields:
                    # Multipart form upload
                    files = {
                        'file': ('document.md', content.encode('utf-8'), 'text/markdown'),
                    }
                    response = requests.post(
                        presigned_url,
                        data=fields,
                        files=files,
                        timeout=30,
                    )
                else:
                    # Simple PUT upload
                    response = requests.put(
                        presigned_url,
                        data=content.encode('utf-8'),
                        headers={'Content-Type': 'text/markdown'},
                        timeout=30,
                    )

                # Check for success (200, 201, or 204)
                if response.status_code in (200, 201, 204):
                    logger.info('S3 upload successful')
                    return

                # Non-success response
                last_error = UploadError(f'S3 upload failed with status {response.status_code}: {response.text[:200]}')
                logger.warning('Upload attempt %s failed: %s', attempt + 1, last_error)

            except requests.exceptions.Timeout:
                last_error = UploadError('S3 upload timeout')
                logger.warning('Upload timeout on attempt %s', attempt + 1)

            except requests.exceptions.RequestException as e:
                last_error = UploadError(f'S3 upload request failed: {e}')
                logger.warning('Upload error on attempt %s: %s', attempt + 1, e)

            # WARNING: time.sleep() blocks the Lambda execution thread. See ADR-003.
            # Exponential backoff before retry
            if attempt < self.max_upload_retries - 1:
                delay = self.upload_retry_delay * (2**attempt)
                logger.info('Retrying upload in %s seconds...', delay)
                time.sleep(delay)

        # All retries exhausted
        raise last_error or UploadError('Upload failed after all retries')
