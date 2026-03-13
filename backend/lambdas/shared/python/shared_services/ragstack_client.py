"""
RAGStack GraphQL Client

Provides methods to interact with RAGStack-Lambda AppSync API
for profile ingestion and semantic search.
"""

import json
import logging
import os
import time
from typing import Any

import boto3
import requests
from shared_services.circuit_breaker import CircuitBreaker, DynamoDBStore, InMemoryStore

logger = logging.getLogger(__name__)

# Lazy initialized resources
_cb_dynamodb_table = None


def _get_cb_table():
    global _cb_dynamodb_table
    if _cb_dynamodb_table is None:
        table_name = os.environ.get('DYNAMODB_TABLE_NAME')
        if table_name:
            _cb_dynamodb_table = boto3.resource('dynamodb').Table(table_name)
    return _cb_dynamodb_table


class RAGStackError(Exception):
    """Base exception for RAGStack client errors"""

    pass


class RAGStackAuthError(RAGStackError):
    """Authentication error (invalid API key)"""

    pass


class RAGStackNetworkError(RAGStackError):
    """Network/connection error"""

    pass


class RAGStackGraphQLError(RAGStackError):
    """GraphQL query/mutation error"""

    pass


class RAGStackClient:
    """
    Client for RAGStack-Lambda GraphQL API.

    Supports:
    - Creating presigned upload URLs for document ingestion
    - Searching the knowledge base
    - Checking document status
    """

    # GraphQL operations
    CREATE_UPLOAD_URL_MUTATION = """
    mutation CreateUploadUrl($filename: String!) {
        createUploadUrl(filename: $filename) {
            uploadUrl
            documentId
            fields
        }
    }
    """

    SEARCH_QUERY = """
    query SearchKnowledgeBase($query: String!, $maxResults: Int) {
        searchKnowledgeBase(query: $query, maxResults: $maxResults) {
            results {
                content
                source
                score
            }
        }
    }
    """

    GET_DOCUMENT_STATUS_QUERY = """
    query GetDocumentStatus($documentId: String!) {
        getDocumentStatus(documentId: $documentId) {
            status
            documentId
            error
        }
    }
    """

    def __init__(
        self,
        endpoint: str,
        api_key: str,
        max_retries: int = 3,
        retry_delay: float = 1.0,
    ):
        """
        Initialize RAGStack client.

        Args:
            endpoint: GraphQL API endpoint URL
            api_key: AppSync API key for authentication
            max_retries: Maximum number of retry attempts for transient failures
            retry_delay: Base delay between retries (exponential backoff)
        """
        if not endpoint:
            raise ValueError('endpoint is required')
        if not api_key:
            raise ValueError('api_key is required')

        self.endpoint = endpoint
        self.api_key = api_key
        self.max_retries = max_retries
        self.retry_delay = retry_delay

        # Initialize circuit breaker with DynamoDB store for distributed state
        cb_table = _get_cb_table()
        cb_store = DynamoDBStore(cb_table) if cb_table else InMemoryStore()

        self._circuit_breaker = CircuitBreaker(
            service_name='ragstack',
            failure_threshold=5,
            recovery_timeout=60.0,
            store=cb_store,
        )
        self.session = requests.Session()
        self.session.headers.update(
            {
                'Content-Type': 'application/json',
                'x-api-key': api_key,
            }
        )

    def _execute_graphql(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        """
        Execute a GraphQL query/mutation with retry logic and circuit breaker protection.

        Args:
            query: GraphQL query or mutation string
            variables: Optional variables for the query

        Returns:
            The 'data' portion of the GraphQL response

        Raises:
            RAGStackAuthError: If API key is invalid
            RAGStackNetworkError: If network request fails or circuit is open
            RAGStackGraphQLError: If GraphQL returns errors
        """

        def _perform_request():
            payload = {'query': query}
            if variables:
                payload['variables'] = variables

            last_error = None

            for attempt in range(self.max_retries):
                try:
                    response = self.session.post(
                        self.endpoint,
                        json=payload,
                        timeout=30,
                    )

                    # Handle HTTP errors
                    if response.status_code == 401:
                        raise RAGStackAuthError('Invalid API key')
                    if response.status_code == 403:
                        raise RAGStackAuthError('Access denied - check API key permissions')

                    response.raise_for_status()

                    # Parse response
                    result = response.json()

                    # Check for GraphQL errors
                    if 'errors' in result:
                        error_messages = [e.get('message', str(e)) for e in result['errors']]
                        raise RAGStackGraphQLError(f'GraphQL errors: {", ".join(error_messages)}')

                    return result.get('data', {})

                except requests.exceptions.Timeout as e:
                    last_error = RAGStackNetworkError(f'Request timeout: {e}')
                    logger.warning(f'Timeout on attempt {attempt + 1}/{self.max_retries}')

                except requests.exceptions.ConnectionError as e:
                    last_error = RAGStackNetworkError(f'Connection error: {e}')
                    logger.warning(f'Connection error on attempt {attempt + 1}/{self.max_retries}')

                except requests.exceptions.RequestException as e:
                    last_error = RAGStackNetworkError(f'Request failed: {e}')
                    logger.warning(f'Request error on attempt {attempt + 1}/{self.max_retries}')

                except (RAGStackAuthError, RAGStackGraphQLError):
                    # Don't retry auth or GraphQL errors
                    raise

                except json.JSONDecodeError as e:
                    last_error = RAGStackError(f'Invalid JSON response: {e}')
                    logger.warning(f'JSON decode error on attempt {attempt + 1}/{self.max_retries}')

                # Exponential backoff before retry
                if attempt < self.max_retries - 1:
                    delay = self.retry_delay * (2**attempt)
                    logger.info(f'Retrying in {delay} seconds...')
                    time.sleep(delay)

            # All retries exhausted
            raise last_error or RAGStackNetworkError('Request failed after all retries')

        try:
            return self._circuit_breaker.call(_perform_request)
        except Exception as e:
            # Re-wrap circuit breaker open error if needed for consistent RAGStackNetworkError
            from shared_services.circuit_breaker import CircuitBreakerOpenError

            if isinstance(e, CircuitBreakerOpenError):
                raise RAGStackNetworkError(str(e)) from e
            raise

    def create_upload_url(self, filename: str) -> dict[str, Any]:
        """
        Create a presigned URL for uploading a document.

        Args:
            filename: Name of the file to upload (should end in .md for markdown)

        Returns:
            Dict containing:
            - uploadUrl: Presigned S3 URL for upload
            - documentId: Assigned document ID
            - fields: Additional form fields for S3 upload (if multipart)
        """
        if not filename:
            raise ValueError('filename is required')

        result = self._execute_graphql(
            self.CREATE_UPLOAD_URL_MUTATION,
            {'filename': filename},
        )

        upload_data = result.get('createUploadUrl')
        if not upload_data:
            raise RAGStackGraphQLError('No upload URL returned from API')

        return {
            'uploadUrl': upload_data.get('uploadUrl'),
            'documentId': upload_data.get('documentId'),
            'fields': upload_data.get('fields') or {},
        }

    def search(self, query: str, max_results: int = 100) -> list[dict[str, Any]]:
        """
        Search the knowledge base for relevant profiles.

        Args:
            query: Search query string
            max_results: Maximum number of results to return (default 100)

        Returns:
            List of search results, each containing:
            - content: Matched content snippet
            - source: Document source/ID (profile_id)
            - score: Relevance score
        """
        if not query:
            raise ValueError('query is required')

        result = self._execute_graphql(
            self.SEARCH_QUERY,
            {'query': query, 'maxResults': max_results},
        )

        search_data = result.get('searchKnowledgeBase', {})
        results = search_data.get('results', [])

        return [
            {
                'content': r.get('content', ''),
                'source': r.get('source', ''),
                'score': r.get('score', 0.0),
            }
            for r in results
        ]

    def get_document_status(self, document_id: str) -> dict[str, Any]:
        """
        Check the indexing status of a document.

        Args:
            document_id: The document ID to check

        Returns:
            Dict containing:
            - status: Current status (e.g., "indexed", "pending", "failed")
            - documentId: The document ID
            - error: Error message if status is "failed"
        """
        if not document_id:
            raise ValueError('document_id is required')

        result = self._execute_graphql(
            self.GET_DOCUMENT_STATUS_QUERY,
            {'documentId': document_id},
        )

        status_data = result.get('getDocumentStatus', {})
        return {
            'status': status_data.get('status', 'unknown'),
            'documentId': status_data.get('documentId', document_id),
            'error': status_data.get('error'),
        }
