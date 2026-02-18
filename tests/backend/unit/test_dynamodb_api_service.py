"""Unit tests for DynamoDBApiService class."""
import base64
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from conftest import load_service_class

# Load DynamoDBApiService using the helper to avoid import conflicts
_service_module = load_service_class('dynamodb-api', 'dynamodb_api_service')
DynamoDBApiService = _service_module.DynamoDBApiService


class TestDynamoDBApiServiceInit:
    """Tests for DynamoDBApiService initialization."""

    def test_service_initializes_with_table(self):
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)
        assert service.table == mock_table


class TestGetUserProfile:
    """Tests for get_user_profile method."""

    def test_returns_profile_from_settings_sk(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'email': 'test@example.com',
                'firstName': 'John',
                'lastName': 'Doe',
                'headline': 'Engineer',
                'createdAt': '2024-01-01T00:00:00',
                'updatedAt': '2024-01-02T00:00:00',
            }
        }
        service = DynamoDBApiService(table=mock_table)
        result = service.get_user_profile('user-123')

        assert result['userId'] == 'user-123'
        assert result['email'] == 'test@example.com'
        assert result['firstName'] == 'John'
        assert result['lastName'] == 'Doe'
        assert result['headline'] == 'Engineer'

    def test_falls_back_to_legacy_profile_sk(self):
        """If #SETTINGS doesn't exist, fall back to PROFILE SK."""
        mock_table = MagicMock()
        # First call (for #SETTINGS) returns no item
        # Second call (for PROFILE) returns item
        mock_table.get_item.side_effect = [
            {},  # #SETTINGS not found
            {'Item': {
                'email': 'legacy@example.com',
                'first_name': 'Legacy',
                'last_name': 'User',
                'created_at': '2023-01-01',
                'updated_at': '2023-06-01',
            }}
        ]
        service = DynamoDBApiService(table=mock_table)
        result = service.get_user_profile('user-456')

        assert result['userId'] == 'user-456'
        assert result['email'] == 'legacy@example.com'
        assert result['firstName'] == 'Legacy'
        assert result['lastName'] == 'User'

    def test_returns_default_when_no_profile(self):
        """Should return default profile when neither SK exists."""
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        service = DynamoDBApiService(table=mock_table)
        result = service.get_user_profile('new-user')

        assert result['userId'] == 'new-user'
        assert result['email'] == ''
        assert result['firstName'] == ''
        assert result['lastName'] == ''
        assert result['linkedin_credentials'] is None
        assert 'createdAt' in result
        assert 'updatedAt' in result


class TestUpdateUserSettings:
    """Tests for update_user_settings method."""

    def test_valid_fields_update_successfully(self):
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.update_user_settings('user-123', {
            'first_name': 'Jane',
            'last_name': 'Smith',
            'headline': 'Senior Engineer',
        })

        assert result == {'success': True}
        mock_table.update_item.assert_called_once()
        call_kwargs = mock_table.update_item.call_args[1]
        assert call_kwargs['Key'] == {'PK': 'USER#user-123', 'SK': '#SETTINGS'}

    def test_invalid_field_returns_error(self):
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        # first_name must be 1-100 chars; empty string should fail
        result = service.update_user_settings('user-123', {
            'first_name': '',
        })

        assert 'error' in result
        assert 'first_name' in result['error']
        mock_table.update_item.assert_not_called()

    def test_no_fields_provided(self):
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.update_user_settings('user-123', {})

        assert result == {'success': True}
        mock_table.update_item.assert_not_called()

    def test_unknown_fields_ignored(self):
        """Fields not in allowed list should be silently ignored."""
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.update_user_settings('user-123', {
            'unknown_field': 'value',
        })

        assert result == {'success': True}
        mock_table.update_item.assert_not_called()

    @patch('socket.getaddrinfo')
    def test_url_safety_validation(self, mock_getaddrinfo):
        """profile_url must be a safe HTTPS URL."""
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        # HTTP URLs should fail
        result = service.update_user_settings('user-123', {
            'profile_url': 'http://example.com/profile',
        })

        assert 'error' in result
        assert 'profile_url' in result['error']

    def test_linkedin_credentials_accepts_string(self):
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.update_user_settings('user-123', {
            'linkedin_credentials': 'sealbox_x25519:b64:encrypted_data',
        })

        assert result == {'success': True}
        mock_table.update_item.assert_called_once()

    def test_linkedin_credentials_accepts_dict(self):
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.update_user_settings('user-123', {
            'linkedin_credentials': {'token': 'encrypted'},
        })

        assert result == {'success': True}
        mock_table.update_item.assert_called_once()


class TestCreateBadContactProfile:
    """Tests for create_bad_contact_profile method."""

    def test_success(self):
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.create_bad_contact_profile('user-123', {
            'profileId': 'https://linkedin.com/in/bad-contact',
            'updates': {
                'name': 'Bad Contact',
                'headline': 'Spammer',
            }
        })

        assert 'profileId' in result
        assert result['evaluated'] is True
        assert result['message'] == 'Bad contact profile metadata updated successfully'
        mock_table.put_item.assert_called_once()

        # Verify the stored item
        put_item = mock_table.put_item.call_args[1]['Item']
        assert put_item['evaluated'] is True
        assert put_item['name'] == 'Bad Contact'

    def test_missing_profile_id(self):
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.create_bad_contact_profile('user-123', {})

        assert 'error' in result
        assert result['error'] == 'profileId is required'
        mock_table.put_item.assert_not_called()

    def test_profile_id_base64_encoded(self):
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        profile_url = 'https://linkedin.com/in/test'
        result = service.create_bad_contact_profile('user-123', {
            'profileId': profile_url,
        })

        expected_b64 = base64.urlsafe_b64encode(profile_url.encode()).decode()
        assert result['profileId'] == expected_b64


class TestGetUserSettings:
    """Tests for get_user_settings method."""

    def test_found(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'PK': 'USER#user-123',
                'SK': '#SETTINGS',
                'linkedin_credentials': 'encrypted',
            }
        }
        service = DynamoDBApiService(table=mock_table)
        result = service.get_user_settings('user-123')

        assert result is not None
        assert result['linkedin_credentials'] == 'encrypted'

    def test_not_found(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        service = DynamoDBApiService(table=mock_table)
        result = service.get_user_settings('nonexistent')

        assert result is None


class TestGetProfileMetadata:
    """Tests for get_profile_metadata method."""

    def test_found(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'PK': 'PROFILE#abc123',
                'SK': '#METADATA',
                'name': 'John Doe',
            }
        }
        service = DynamoDBApiService(table=mock_table)
        result = service.get_profile_metadata('abc123')

        assert result is not None
        assert result['name'] == 'John Doe'

    def test_not_found(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        service = DynamoDBApiService(table=mock_table)
        result = service.get_profile_metadata('nonexistent')

        assert result is None

    def test_client_error_returns_none(self):
        mock_table = MagicMock()
        mock_table.get_item.side_effect = ClientError(
            {'Error': {'Code': 'InternalServerError', 'Message': 'Test'}},
            'GetItem'
        )
        service = DynamoDBApiService(table=mock_table)
        result = service.get_profile_metadata('error-id')

        assert result is None


class TestValidateProfileField:
    """Tests for validate_profile_field method."""

    def test_valid_first_name(self):
        service = DynamoDBApiService(table=MagicMock())
        assert service.validate_profile_field('first_name', 'John') is True

    def test_empty_first_name_rejected(self):
        service = DynamoDBApiService(table=MagicMock())
        assert service.validate_profile_field('first_name', '') is False

    def test_too_long_first_name_rejected(self):
        service = DynamoDBApiService(table=MagicMock())
        assert service.validate_profile_field('first_name', 'x' * 101) is False

    def test_valid_headline(self):
        service = DynamoDBApiService(table=MagicMock())
        assert service.validate_profile_field('headline', 'Software Engineer') is True

    def test_too_long_headline_rejected(self):
        service = DynamoDBApiService(table=MagicMock())
        assert service.validate_profile_field('headline', 'x' * 221) is False

    def test_empty_headline_allowed(self):
        """Headline can be empty (unlike first_name)."""
        service = DynamoDBApiService(table=MagicMock())
        assert service.validate_profile_field('headline', '') is True

    def test_unknown_field_rejected(self):
        service = DynamoDBApiService(table=MagicMock())
        assert service.validate_profile_field('unknown_field', 'value') is False

    def test_linkedin_credentials_string(self):
        service = DynamoDBApiService(table=MagicMock())
        assert service.validate_profile_field('linkedin_credentials', 'encrypted') is True

    def test_linkedin_credentials_dict(self):
        service = DynamoDBApiService(table=MagicMock())
        assert service.validate_profile_field('linkedin_credentials', {'key': 'val'}) is True

    def test_linkedin_credentials_list_rejected(self):
        service = DynamoDBApiService(table=MagicMock())
        assert service.validate_profile_field('linkedin_credentials', ['bad']) is False

    def test_ai_generated_ideas_accepts_variants(self):
        service = DynamoDBApiService(table=MagicMock())
        assert service.validate_profile_field('ai_generated_ideas', 'string') is True
        assert service.validate_profile_field('ai_generated_ideas', ['list']) is True
        assert service.validate_profile_field('ai_generated_ideas', {'dict': True}) is True

    def test_interests_accepts_string_and_list(self):
        service = DynamoDBApiService(table=MagicMock())
        assert service.validate_profile_field('interests', 'tech, music') is True
        assert service.validate_profile_field('interests', ['tech', 'music']) is True

    @patch('socket.getaddrinfo')
    def test_profile_url_requires_https(self, mock_getaddrinfo):
        service = DynamoDBApiService(table=MagicMock())
        assert service.validate_profile_field('profile_url', 'http://example.com') is False

    def test_summary_max_length(self):
        service = DynamoDBApiService(table=MagicMock())
        assert service.validate_profile_field('summary', 'x' * 2600) is True
        assert service.validate_profile_field('summary', 'x' * 2601) is False
