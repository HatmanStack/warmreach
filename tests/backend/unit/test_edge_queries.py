"""Unit tests for EdgeQueryService."""
import base64
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from shared_services.edge_query_service import EdgeQueryService
from errors.exceptions import ExternalServiceError


def _encode(profile_id: str) -> str:
    return base64.urlsafe_b64encode(profile_id.encode()).decode()


class TestGetConnectionsByStatus:
    """Tests for EdgeQueryService.get_connections_by_status."""

    def test_returns_formatted_connections(self):
        mock_table = MagicMock()
        pid = _encode('john')
        mock_table.query.return_value = {
            'Items': [
                {'PK': 'USER#u1', 'SK': f'PROFILE#{pid}', 'status': 'ally', 'addedAt': '2024-01-01', 'messages': []}
            ],
            'LastEvaluatedKey': None,
        }
        mock_dynamodb = MagicMock()
        mock_dynamodb.batch_get_item.return_value = {
            'Responses': {
                'test-table': [
                    {'PK': f'PROFILE#{pid}', 'SK': '#METADATA', 'name': 'John Doe', 'currentTitle': 'Engineer'}
                ]
            }
        }
        mock_table.table_name = 'test-table'
        service = EdgeQueryService(table=mock_table, dynamodb_resource=mock_dynamodb)

        result = service.get_connections_by_status('u1')

        assert result['success'] is True
        assert result['count'] == 1
        assert result['connections'][0]['first_name'] == 'John'

    def test_filters_by_status_via_gsi(self):
        mock_table = MagicMock()
        pid = _encode('jane')
        mock_table.query.return_value = {
            'Items': [
                {'PK': 'USER#u1', 'SK': f'PROFILE#{pid}', 'status': 'ally', 'addedAt': '2024-01-01', 'messages': []}
            ],
            'LastEvaluatedKey': None,
        }
        mock_dynamodb = MagicMock()
        mock_dynamodb.batch_get_item.return_value = {
            'Responses': {
                'test-table': [{'PK': f'PROFILE#{pid}', 'SK': '#METADATA', 'name': 'Jane'}]
            }
        }
        mock_table.table_name = 'test-table'
        service = EdgeQueryService(table=mock_table, dynamodb_resource=mock_dynamodb)

        result = service.get_connections_by_status('u1', status='ally')

        assert result['success'] is True
        # Verify GSI query was used (IndexName param)
        call_kwargs = mock_table.query.call_args[1]
        assert call_kwargs.get('IndexName') == 'GSI1'


class TestCheckExists:
    """Tests for EdgeQueryService.check_exists."""

    def test_returns_true_when_exists(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'status': 'ally', 'addedAt': '2024-01-01'}
        }
        service = EdgeQueryService(table=mock_table)

        result = service.check_exists('u1', 'profile-1')

        assert result['exists'] is True

    def test_returns_false_when_not_exists(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        service = EdgeQueryService(table=mock_table)

        result = service.check_exists('u1', 'profile-1')

        assert result['exists'] is False
        assert result['edge_data'] is None


class TestQueryAllEdges:
    """Tests for EdgeQueryService.query_all_edges."""

    def test_returns_all_edges_with_pagination(self):
        mock_table = MagicMock()
        # First page returns items + LastEvaluatedKey, second page returns remaining
        mock_table.query.side_effect = [
            {'Items': [{'SK': 'PROFILE#a'}], 'LastEvaluatedKey': {'PK': 'x', 'SK': 'y'}},
            {'Items': [{'SK': 'PROFILE#b'}]},
        ]
        service = EdgeQueryService(table=mock_table)

        result = service.query_all_edges('u1')

        assert len(result) == 2
        assert mock_table.query.call_count == 2

    def test_single_page(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [{'SK': 'PROFILE#a'}]}
        service = EdgeQueryService(table=mock_table)

        result = service.query_all_edges('u1')

        assert len(result) == 1


class TestGetProfileMetadata:
    """Tests for EdgeQueryService.get_profile_metadata."""

    def test_returns_metadata(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'PK': 'PROFILE#abc', 'SK': '#METADATA', 'name': 'Alice'}
        }
        service = EdgeQueryService(table=mock_table)

        result = service.get_profile_metadata('abc')

        assert result['name'] == 'Alice'

    def test_returns_empty_when_missing(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        service = EdgeQueryService(table=mock_table)

        result = service.get_profile_metadata('abc')

        assert result == {}


class TestBatchGetProfileMetadata:
    """Tests for EdgeQueryService.batch_get_profile_metadata."""

    def test_returns_metadata_for_multiple_profiles(self):
        mock_table = MagicMock()
        mock_table.table_name = 'test-table'
        mock_dynamodb = MagicMock()
        mock_dynamodb.batch_get_item.return_value = {
            'Responses': {
                'test-table': [
                    {'PK': 'PROFILE#a', 'name': 'Alice'},
                    {'PK': 'PROFILE#b', 'name': 'Bob'},
                ]
            }
        }
        service = EdgeQueryService(table=mock_table, dynamodb_resource=mock_dynamodb)

        result = service.batch_get_profile_metadata(['a', 'b'])

        assert len(result) == 2
        assert result['a']['name'] == 'Alice'
        assert result['b']['name'] == 'Bob'

    def test_returns_empty_for_empty_input(self):
        mock_table = MagicMock()
        service = EdgeQueryService(table=mock_table)

        result = service.batch_get_profile_metadata([])

        assert result == {}

    def test_handles_unprocessed_keys(self):
        mock_table = MagicMock()
        mock_table.table_name = 'test-table'
        mock_dynamodb = MagicMock()
        mock_dynamodb.batch_get_item.side_effect = [
            {
                'Responses': {'test-table': [{'PK': 'PROFILE#a', 'name': 'Alice'}]},
                'UnprocessedKeys': {'test-table': {'Keys': [{'PK': 'PROFILE#b', 'SK': '#METADATA'}]}},
            },
            {
                'Responses': {'test-table': [{'PK': 'PROFILE#b', 'name': 'Bob'}]},
                'UnprocessedKeys': {},
            },
        ]
        service = EdgeQueryService(table=mock_table, dynamodb_resource=mock_dynamodb)

        result = service.batch_get_profile_metadata(['a', 'b'])

        assert len(result) == 2
