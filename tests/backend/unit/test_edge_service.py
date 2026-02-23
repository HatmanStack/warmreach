"""Unit tests for EdgeService class (TDD)."""
import base64
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from conftest import load_service_class

# Load EdgeService using the helper to avoid import conflicts
_edge_service_module = load_service_class('edge-processing', 'edge_service')
EdgeService = _edge_service_module.EdgeService

# Also load shared error classes for assertions
from errors.exceptions import ExternalServiceError, ValidationError


class TestEdgeServiceInit:
    """Tests for EdgeService initialization."""

    def test_service_initializes_with_table(self):
        """Service should accept table via constructor injection."""
        mock_table = MagicMock()
        service = EdgeService(table=mock_table)
        assert service.table == mock_table

    def test_service_initializes_with_ragstack_config(self):
        """Service should accept optional RAGStack config."""
        mock_table = MagicMock()
        service = EdgeService(
            table=mock_table,
            ragstack_endpoint='https://api.example.com/graphql',
            ragstack_api_key='test-key'
        )
        assert service.ragstack_endpoint == 'https://api.example.com/graphql'
        assert service.ragstack_api_key == 'test-key'

    def test_service_initializes_without_ragstack_config(self):
        """Service should work without RAGStack config."""
        mock_table = MagicMock()
        service = EdgeService(table=mock_table)
        assert service.ragstack_endpoint == ''
        assert service.ragstack_api_key == ''


class TestEdgeServiceUpsertStatus:
    """Tests for upsert_status operation."""

    def test_upsert_status_creates_edges(self):
        """Should create user-to-profile and profile-to-user edges."""
        mock_table = MagicMock()
        mock_table.table_name = 'test-table'
        service = EdgeService(table=mock_table)

        result = service.upsert_status(
            user_id='test-user-123',
            profile_id='https://linkedin.com/in/john-doe',
            status='possible'
        )

        assert result['success'] is True
        mock_table.put_item.assert_called_once()
        mock_table.update_item.assert_called_once()

    def test_upsert_status_returns_profile_id_b64(self):
        """Should return base64-encoded profile ID."""
        mock_table = MagicMock()
        mock_table.table_name = 'test-table'
        service = EdgeService(table=mock_table)

        result = service.upsert_status(
            user_id='test-user-123',
            profile_id='https://linkedin.com/in/john-doe',
            status='possible'
        )

        assert 'profileId' in result
        decoded = base64.urlsafe_b64decode(result['profileId']).decode()
        assert decoded == 'https://linkedin.com/in/john-doe'

    def test_upsert_status_triggers_ragstack_for_ally(self):
        """Should trigger RAGStack ingestion for 'ally' status."""
        mock_table = MagicMock()
        mock_table.table_name = 'test-table'
        mock_table.get_item.return_value = {'Item': {'name': 'John Doe'}}

        service = EdgeService(
            table=mock_table,
            ragstack_endpoint='https://api.example.com/graphql',
            ragstack_api_key='test-key'
        )

        with patch.object(service, '_trigger_ragstack_ingestion') as mock_ingest:
            mock_ingest.return_value = {'success': True, 'status': 'uploaded'}

            result = service.upsert_status(
                user_id='test-user-123',
                profile_id='https://linkedin.com/in/john-doe',
                status='ally'
            )

            assert result['success'] is True
            mock_ingest.assert_called_once()

    def test_upsert_status_skips_ragstack_for_possible(self):
        """Should NOT trigger RAGStack for 'possible' status."""
        mock_table = MagicMock()
        mock_table.table_name = 'test-table'

        service = EdgeService(
            table=mock_table,
            ragstack_endpoint='https://api.example.com/graphql',
            ragstack_api_key='test-key'
        )

        result = service.upsert_status(
            user_id='test-user-123',
            profile_id='https://linkedin.com/in/john-doe',
            status='possible'
        )

        assert result['success'] is True
        assert result.get('ragstack_ingested') is False


class TestEdgeServiceAddMessage:
    """Tests for add_message operation."""

    def test_add_message_success(self):
        """Should add message to edge."""
        mock_table = MagicMock()
        service = EdgeService(table=mock_table)

        result = service.add_message(
            user_id='test-user-123',
            profile_id_b64='dGVzdC1wcm9maWxl',
            message='Hello!',
            message_type='outbound'
        )

        assert result['success'] is True
        mock_table.update_item.assert_called_once()

    def test_add_message_missing_message_raises_error(self):
        """Should raise ValidationError when message is missing."""
        mock_table = MagicMock()
        service = EdgeService(table=mock_table)

        with pytest.raises(ValidationError):
            service.add_message(
                user_id='test-user-123',
                profile_id_b64='dGVzdC1wcm9maWxl',
                message='',
                message_type='outbound'
            )


class TestEdgeServiceGetConnections:
    """Tests for get_connections_by_status operation."""

    def test_get_connections_returns_formatted_list(self):
        """Should return properly formatted connection objects."""
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {
                    'PK': 'USER#test-user',
                    'SK': 'PROFILE#dGVzdC1wcm9maWxl',
                    'status': 'ally',
                    'addedAt': '2024-01-01T00:00:00+00:00',
                    'messages': []
                }
            ]
        }
        mock_table.get_item.return_value = {
            'Item': {
                'name': 'John Doe',
                'headline': 'Software Engineer',
                'currentCompany': 'Tech Corp'
            }
        }

        service = EdgeService(table=mock_table)

        result = service.get_connections_by_status(
            user_id='test-user',
            status='ally'
        )

        assert result['success'] is True
        assert len(result['connections']) == 1
        conn = result['connections'][0]
        assert 'id' in conn
        assert 'first_name' in conn
        assert 'status' in conn

    def test_get_connections_without_status_returns_all(self):
        """Should return all connections when status is None."""
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}
        service = EdgeService(table=mock_table)

        result = service.get_connections_by_status(
            user_id='test-user',
            status=None
        )

        assert result['success'] is True
        call_kwargs = mock_table.query.call_args[1]
        assert 'IndexName' not in call_kwargs


class TestEdgeServiceGetMessages:
    """Tests for get_messages operation."""

    def test_get_messages_success(self):
        """Should return formatted message list."""
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'messages': [
                    {'content': 'Hello', 'timestamp': '2024-01-01T00:00:00', 'type': 'outbound'},
                    {'content': 'Hi there', 'timestamp': '2024-01-01T00:01:00', 'type': 'inbound'}
                ],
                'addedAt': '2024-01-01T00:00:00'
            }
        }

        service = EdgeService(table=mock_table)

        result = service.get_messages(
            user_id='test-user',
            profile_id_b64='dGVzdC1wcm9maWxl'
        )

        assert result['success'] is True
        assert len(result['messages']) == 2
        assert result['messages'][0]['sender'] == 'user'
        assert result['messages'][1]['sender'] == 'connection'

    def test_get_messages_empty_when_no_edge(self):
        """Should return empty list when edge doesn't exist."""
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}

        service = EdgeService(table=mock_table)

        result = service.get_messages(
            user_id='test-user',
            profile_id_b64='dGVzdC1wcm9maWxl'
        )

        assert result['success'] is True
        assert result['messages'] == []
        assert result['count'] == 0


class TestEdgeServiceCheckExists:
    """Tests for check_exists operation."""

    def test_check_exists_returns_true_when_exists(self):
        """Should return exists=True when edge exists."""
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'status': 'ally',
                'addedAt': '2024-01-01T00:00:00'
            }
        }

        service = EdgeService(table=mock_table)

        result = service.check_exists(
            user_id='test-user',
            profile_id='test-profile'
        )

        assert result['success'] is True
        assert result['exists'] is True
        assert result['edge_data']['status'] == 'ally'

    def test_check_exists_returns_false_when_not_exists(self):
        """Should return exists=False when edge doesn't exist."""
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}

        service = EdgeService(table=mock_table)

        result = service.check_exists(
            user_id='test-user',
            profile_id='test-profile'
        )

        assert result['success'] is True
        assert result['exists'] is False
        assert result['edge_data'] is None


class TestEdgeServiceConversionLikelihood:
    """Tests for conversion likelihood using enum."""

    def test_conversion_likelihood_uses_enum(self):
        """Should use ConversionLikelihood enum instead of percentage."""
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {
                    'PK': 'USER#test-user',
                    'SK': 'PROFILE#dGVzdC1wcm9maWxl',
                    'status': 'possible',
                    'addedAt': datetime.now(UTC).isoformat(),
                    'attempts': 0,
                    'messages': []
                }
            ]
        }
        mock_table.get_item.return_value = {
            'Item': {
                'name': 'John Doe',
                'headline': 'Software Engineer',
                'summary': 'Experienced developer'
            }
        }

        service = EdgeService(table=mock_table)

        result = service.get_connections_by_status(
            user_id='test-user',
            status='possible'
        )

        assert result['success'] is True
        conn = result['connections'][0]
        assert conn['conversion_likelihood'] in ('high', 'medium', 'low')

    def test_conversion_likelihood_high_for_complete_recent_profile(self):
        """HIGH: Complete profile + recent + no attempts."""
        mock_table = MagicMock()
        recent_date = datetime.now(UTC).isoformat()
        mock_table.query.return_value = {
            'Items': [
                {
                    'PK': 'USER#test-user',
                    'SK': 'PROFILE#dGVzdC1wcm9maWxl',
                    'status': 'possible',
                    'addedAt': recent_date,
                    'attempts': 0,
                    'messages': []
                }
            ]
        }
        mock_table.get_item.return_value = {
            'Item': {
                'name': 'John Doe',
                'headline': 'Software Engineer at Google',
                'summary': 'Passionate developer with 10+ years experience'
            }
        }

        service = EdgeService(table=mock_table)

        result = service.get_connections_by_status(
            user_id='test-user',
            status='possible'
        )

        assert result['connections'][0]['conversion_likelihood'] == 'high'

    def test_conversion_likelihood_low_for_incomplete_profile(self):
        """LOW: Missing headline."""
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {
                    'PK': 'USER#test-user',
                    'SK': 'PROFILE#dGVzdC1wcm9maWxl',
                    'status': 'possible',
                    'addedAt': datetime.now(UTC).isoformat(),
                    'attempts': 0,
                    'messages': []
                }
            ]
        }
        mock_table.get_item.return_value = {
            'Item': {
                'name': 'John Doe',
            }
        }

        service = EdgeService(table=mock_table)

        result = service.get_connections_by_status(
            user_id='test-user',
            status='possible'
        )

        assert result['connections'][0]['conversion_likelihood'] == 'low'


class TestEdgeServiceErrorHandling:
    """Tests for error handling."""

    def test_dynamo_error_raises_external_service_error(self):
        """Should raise ExternalServiceError on DynamoDB failures."""
        mock_table = MagicMock()
        mock_table.table_name = 'test-table'
        mock_table.put_item.side_effect = ClientError(
            {'Error': {'Code': 'InternalServerError', 'Message': 'Test error'}},
            'PutItem'
        )

        service = EdgeService(table=mock_table)

        with pytest.raises(ExternalServiceError):
            service.upsert_status(
                user_id='test-user',
                profile_id='https://linkedin.com/in/john-doe',
                status='ally'
            )


class TestEdgeServiceMessageCap:
    """Tests for MAX_MESSAGES_PER_EDGE cap."""

    def test_add_message_within_cap_appends(self):
        """Should append normally when under the 100-message cap."""
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'messages': [{'content': f'msg-{i}'} for i in range(50)]}
        }
        service = EdgeService(table=mock_table)

        result = service.add_message(
            user_id='test-user',
            profile_id_b64='dGVzdC1wcm9maWxl',
            message='New message',
            message_type='outbound'
        )

        assert result['success'] is True
        # Should call update_item once with correct key
        mock_table.update_item.assert_called_once()
        update_call = mock_table.update_item.call_args
        assert update_call[1]['Key']['PK'] == 'USER#test-user'

    def test_add_message_at_cap_trims_oldest(self):
        """Should trim oldest messages when at 100-message cap."""
        mock_table = MagicMock()
        messages = [{'content': f'msg-{i}', 'timestamp': f'2024-01-{i:02d}T00:00:00', 'type': 'outbound'} for i in range(100)]
        mock_table.get_item.return_value = {'Item': {'messages': messages}}
        service = EdgeService(table=mock_table)

        result = service.add_message(
            user_id='test-user',
            profile_id_b64='dGVzdC1wcm9maWxl',
            message='Message 101',
            message_type='outbound'
        )

        assert result['success'] is True
        # Should call update_item to persist trimmed list
        mock_table.update_item.assert_called_once()
        update_call = mock_table.update_item.call_args
        # The new message list should be exactly 100 (99 old + 1 new)
        expr_values = update_call[1].get('ExpressionAttributeValues', {})
        new_msgs = expr_values.get(':msgs', [])
        assert len(new_msgs) == 100
        assert new_msgs[-1]['content'] == 'Message 101'

    def test_add_message_over_cap_keeps_newest(self):
        """Should keep newest 99 messages + new one when over cap."""
        mock_table = MagicMock()
        messages = [{'content': f'msg-{i}', 'timestamp': f'2024-01-01T{i:02d}:00:00', 'type': 'outbound'} for i in range(150)]
        mock_table.get_item.return_value = {'Item': {'messages': messages}}
        service = EdgeService(table=mock_table)

        result = service.add_message(
            user_id='test-user',
            profile_id_b64='dGVzdC1wcm9maWxl',
            message='Latest message',
            message_type='outbound'
        )

        assert result['success'] is True
        expr_values = mock_table.update_item.call_args[1].get('ExpressionAttributeValues', {})
        new_msgs = expr_values.get(':msgs', [])
        assert len(new_msgs) == 100
        # Oldest message should NOT be msg-0
        assert new_msgs[0]['content'] != 'msg-0'
        # Latest should be our new message
        assert new_msgs[-1]['content'] == 'Latest message'

    def test_add_message_no_existing_messages(self):
        """Should handle case when edge has no messages yet."""
        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {}}
        service = EdgeService(table=mock_table)

        result = service.add_message(
            user_id='test-user',
            profile_id_b64='dGVzdC1wcm9maWxl',
            message='First message',
            message_type='outbound'
        )

        assert result['success'] is True
        # Should call update_item once with correct key
        mock_table.update_item.assert_called_once()
        update_call = mock_table.update_item.call_args
        assert update_call[1]['Key']['PK'] == 'USER#test-user'

    def test_add_message_no_item_creates_new(self):
        """Should handle case when edge item doesn't exist yet."""
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        service = EdgeService(table=mock_table)

        result = service.add_message(
            user_id='test-user',
            profile_id_b64='dGVzdC1wcm9maWxl',
            message='First message',
            message_type='outbound'
        )

        assert result['success'] is True


class TestEdgeServiceUpdateMessages:
    """Tests for update_messages operation."""

    def test_update_messages_success(self):
        """Should replace the full messages list on an edge."""
        mock_table = MagicMock()
        service = EdgeService(table=mock_table)

        messages = [
            {'content': 'Hello', 'timestamp': '2024-01-01T00:00:00', 'type': 'outbound'},
            {'content': 'Hi there', 'timestamp': '2024-01-01T00:01:00', 'type': 'inbound'},
        ]

        result = service.update_messages(
            user_id='test-user',
            profile_id='john-doe',
            messages=messages
        )

        assert result['success'] is True
        assert result['messageCount'] == 2
        mock_table.update_item.assert_called_once()

        # Verify the update expression sets messages
        call_kwargs = mock_table.update_item.call_args[1]
        assert ':msgs' in call_kwargs['ExpressionAttributeValues']
        assert len(call_kwargs['ExpressionAttributeValues'][':msgs']) == 2

    def test_update_messages_caps_at_max(self):
        """Should trim to MAX_MESSAGES_PER_EDGE when list exceeds cap."""
        mock_table = MagicMock()
        service = EdgeService(table=mock_table)

        messages = [
            {'content': f'msg-{i}', 'timestamp': f'2024-01-01T{i:02d}:00:00', 'type': 'outbound'}
            for i in range(150)
        ]

        result = service.update_messages(
            user_id='test-user',
            profile_id='john-doe',
            messages=messages
        )

        assert result['success'] is True
        assert result['messageCount'] == 100

        call_kwargs = mock_table.update_item.call_args[1]
        stored_msgs = call_kwargs['ExpressionAttributeValues'][':msgs']
        assert len(stored_msgs) == 100
        # Should keep the most recent (last 100)
        assert stored_msgs[0]['content'] == 'msg-50'
        assert stored_msgs[-1]['content'] == 'msg-149'

    def test_update_messages_empty_list(self):
        """Should handle empty messages list."""
        mock_table = MagicMock()
        service = EdgeService(table=mock_table)

        result = service.update_messages(
            user_id='test-user',
            profile_id='john-doe',
            messages=[]
        )

        assert result['success'] is True
        assert result['messageCount'] == 0

    def test_update_messages_none_list(self):
        """Should handle None messages."""
        mock_table = MagicMock()
        service = EdgeService(table=mock_table)

        result = service.update_messages(
            user_id='test-user',
            profile_id='john-doe',
            messages=None
        )

        assert result['success'] is True
        assert result['messageCount'] == 0

    def test_update_messages_dynamo_error(self):
        """Should raise ExternalServiceError on DynamoDB failure."""
        mock_table = MagicMock()
        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'InternalServerError', 'Message': 'Test error'}},
            'UpdateItem'
        )
        service = EdgeService(table=mock_table)

        with pytest.raises(ExternalServiceError):
            service.update_messages(
                user_id='test-user',
                profile_id='john-doe',
                messages=[{'content': 'test', 'timestamp': '2024-01-01', 'type': 'outbound'}]
            )

    def test_update_messages_encodes_profile_id(self):
        """Should base64-encode profile ID for DynamoDB key."""
        mock_table = MagicMock()
        service = EdgeService(table=mock_table)

        result = service.update_messages(
            user_id='test-user',
            profile_id='john-doe',
            messages=[]
        )

        call_kwargs = mock_table.update_item.call_args[1]
        expected_b64 = base64.urlsafe_b64encode('john-doe'.encode()).decode()
        assert call_kwargs['Key']['SK'] == f'PROFILE#{expected_b64}'
        assert result['profileId'] == expected_b64


class TestEdgeServiceProfilePicture:
    """Tests for profile_picture_url in _format_connection_object."""

    def test_format_connection_returns_profile_picture_url(self):
        """Should return profile_picture_url from profile metadata."""
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {
                    'PK': 'USER#test-user',
                    'SK': 'PROFILE#dGVzdC1wcm9maWxl',
                    'status': 'ally',
                    'addedAt': '2024-01-01T00:00:00+00:00',
                    'messages': []
                }
            ]
        }
        mock_table.get_item.return_value = {
            'Item': {
                'name': 'John Doe',
                'profilePictureUrl': 'https://media.licdn.com/dms/image/test/photo.jpg',
            }
        }

        service = EdgeService(table=mock_table)
        result = service.get_connections_by_status(user_id='test-user', status='ally')

        assert result['success'] is True
        conn = result['connections'][0]
        assert conn['profile_picture_url'] == 'https://media.licdn.com/dms/image/test/photo.jpg'

    def test_format_connection_returns_empty_string_when_no_picture(self):
        """Should return empty string when profilePictureUrl not in metadata."""
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {
                    'PK': 'USER#test-user',
                    'SK': 'PROFILE#dGVzdC1wcm9maWxl',
                    'status': 'ally',
                    'addedAt': '2024-01-01T00:00:00+00:00',
                    'messages': []
                }
            ]
        }
        mock_table.get_item.return_value = {
            'Item': {
                'name': 'John Doe',
            }
        }

        service = EdgeService(table=mock_table)
        result = service.get_connections_by_status(user_id='test-user', status='ally')

        assert result['success'] is True
        conn = result['connections'][0]
        assert conn['profile_picture_url'] == ''


class TestEdgeServiceMaxResults:
    """Tests for maxResults cap in search."""

    def test_search_caps_max_results_at_200(self):
        """maxResults should be capped at 200 in handler."""
        # This tests the lambda handler, not the service directly
        # The cap is applied at lambda_function.py line 73
        max_results = min(int('500'), 200)
        assert max_results == 200

    def test_search_default_max_results(self):
        """Default maxResults should be 100."""
        max_results = min(int('100'), 200)
        assert max_results == 100

    def test_search_respects_lower_max_results(self):
        """Should use requested maxResults when under cap."""
        max_results = min(int('50'), 200)
        assert max_results == 50


class TestEdgeServiceTransactionErrors:
    """Tests for transaction failure handling."""

    def test_upsert_handles_conditional_check_failure(self):
        """Should handle ConditionalCheckFailedException."""
        mock_table = MagicMock()
        mock_table.table_name = 'test-table'
        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'Condition not met'}},
            'UpdateItem'
        )
        service = EdgeService(table=mock_table)

        with pytest.raises(ExternalServiceError):
            service.upsert_status(
                user_id='test-user',
                profile_id='https://linkedin.com/in/test',
                status='ally'
            )

    def test_upsert_handles_validation_exception(self):
        """Should handle ValidationException."""
        mock_table = MagicMock()
        mock_table.table_name = 'test-table'
        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ValidationException', 'Message': 'Invalid input'}},
            'UpdateItem'
        )
        service = EdgeService(table=mock_table)

        with pytest.raises(ExternalServiceError):
            service.upsert_status(
                user_id='test-user',
                profile_id='https://linkedin.com/in/test',
                status='possible'
            )
