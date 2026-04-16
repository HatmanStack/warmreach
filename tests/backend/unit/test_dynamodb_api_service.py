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

    def test_url_safety_validation(self):
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

    def test_source_field_persisted(self):
        """Source field is written to the PROFILE#metadata item."""
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.create_bad_contact_profile('user-123', {
            'profileId': 'manual://john-doe-123',
            'source': 'manual',
            'updates': {'name': 'John Doe'},
        })

        assert 'error' not in result
        put_item = mock_table.put_item.call_args[1]['Item']
        assert put_item['source'] == 'manual'

    def test_source_defaults_to_linkedin(self):
        """When source is not provided, defaults to 'linkedin'."""
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.create_bad_contact_profile('user-123', {
            'profileId': 'https://linkedin.com/in/someone',
            'updates': {'name': 'Someone'},
        })

        assert 'error' not in result
        put_item = mock_table.put_item.call_args[1]['Item']
        assert put_item['source'] == 'linkedin'

    def test_invalid_source_returns_error(self):
        """Invalid source value returns an error."""
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.create_bad_contact_profile('user-123', {
            'profileId': 'manual://test-123',
            'source': 'invalid',
        })

        assert 'error' in result
        assert 'source' in result['error'].lower() or 'Invalid' in result['error']
        mock_table.put_item.assert_not_called()

    def test_status_parameter_used(self):
        """When status is passed, the return reflects it (no edge item in current impl)."""
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.create_bad_contact_profile('user-123', {
            'profileId': 'manual://ally-contact-123',
            'status': 'ally',
            'source': 'manual',
            'updates': {'name': 'Ally Contact'},
        })

        assert 'error' not in result
        assert result.get('status') == 'ally'

    def test_status_defaults_to_processed(self):
        """When status is not provided, defaults to 'processed'."""
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.create_bad_contact_profile('user-123', {
            'profileId': 'https://linkedin.com/in/contact',
            'updates': {'name': 'Contact'},
        })

        assert 'error' not in result
        assert result.get('status') == 'processed'

    def test_invalid_status_returns_error(self):
        """Invalid status value returns an error."""
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.create_bad_contact_profile('user-123', {
            'profileId': 'manual://test-123',
            'status': 'bogus',
        })

        assert 'error' in result
        mock_table.put_item.assert_not_called()


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

    def test_profile_url_requires_https(self):
        service = DynamoDBApiService(table=MagicMock())
        assert service.validate_profile_field('profile_url', 'http://example.com') is False

    def test_summary_max_length(self):
        service = DynamoDBApiService(table=MagicMock())
        assert service.validate_profile_field('summary', 'x' * 2600) is True
        assert service.validate_profile_field('summary', 'x' * 2601) is False


class TestIsSafeUrl:
    """Tests for _is_safe_url SSRF protection (parse-only, no DNS)."""

    def test_valid_https_url(self):
        """Valid HTTPS URL is accepted."""
        service = DynamoDBApiService(table=MagicMock())
        assert service._is_safe_url('https://linkedin.com/in/foo') is True

    def test_http_rejected(self):
        """Non-HTTPS scheme is rejected."""
        service = DynamoDBApiService(table=MagicMock())
        assert service._is_safe_url('http://linkedin.com/in/foo') is False

    def test_localhost_rejected(self):
        """Localhost hostnames are rejected."""
        service = DynamoDBApiService(table=MagicMock())
        assert service._is_safe_url('https://localhost/') is False

    def test_loopback_ip_rejected(self):
        """Loopback IP 127.0.0.1 is rejected."""
        service = DynamoDBApiService(table=MagicMock())
        assert service._is_safe_url('https://127.0.0.1/') is False

    def test_private_10_rejected(self):
        """Private 10.x.x.x IP is rejected."""
        service = DynamoDBApiService(table=MagicMock())
        assert service._is_safe_url('https://10.0.0.1/') is False

    def test_private_192_168_rejected(self):
        """Private 192.168.x.x IP is rejected."""
        service = DynamoDBApiService(table=MagicMock())
        assert service._is_safe_url('https://192.168.1.1/') is False

    def test_link_local_rejected(self):
        """AWS metadata endpoint (link-local) is rejected."""
        service = DynamoDBApiService(table=MagicMock())
        assert service._is_safe_url('https://169.254.169.254/') is False

    def test_ipv6_loopback_rejected(self):
        """IPv6 loopback ::1 is rejected."""
        service = DynamoDBApiService(table=MagicMock())
        assert service._is_safe_url('https://[::1]/') is False

    def test_empty_string_returns_false(self):
        """Empty string returns False."""
        service = DynamoDBApiService(table=MagicMock())
        assert service._is_safe_url('') is False

    def test_no_hostname_returns_false(self):
        """URL without hostname returns False."""
        service = DynamoDBApiService(table=MagicMock())
        assert service._is_safe_url('https://') is False
        assert service._is_safe_url('not-a-url') is False

    def test_reserved_hostnames_rejected(self):
        """Hostnames ending in .local, .internal, .localhost are rejected."""
        service = DynamoDBApiService(table=MagicMock())
        assert service._is_safe_url('https://myhost.local/') is False
        assert service._is_safe_url('https://myhost.internal/') is False
        assert service._is_safe_url('https://myhost.localhost/') is False

    def test_private_172_rejected(self):
        """Private 172.16-31.x.x IPs are rejected."""
        service = DynamoDBApiService(table=MagicMock())
        assert service._is_safe_url('https://172.16.0.1/') is False
        assert service._is_safe_url('https://172.31.255.255/') is False
        # 172.32.x is NOT private
        assert service._is_safe_url('https://172.32.0.1/') is True


class TestDailyScrapeCount:
    """Tests for daily scrape count methods."""

    def test_get_returns_0_for_missing_item(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        service = DynamoDBApiService(table=mock_table)

        result = service.get_daily_scrape_count('user-123', '2026-03-13')
        assert result == {'count': 0}

    def test_get_returns_existing_count(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'PK': 'USER#user-123', 'SK': '#DAILY_SCRAPE_COUNT#2026-03-13', 'count': 42}
        }
        service = DynamoDBApiService(table=mock_table)

        result = service.get_daily_scrape_count('user-123', '2026-03-13')
        assert result == {'count': 42}

    def test_increment_creates_item_with_count_1(self):
        mock_table = MagicMock()
        mock_table.update_item.return_value = {'Attributes': {'count': 1}}
        service = DynamoDBApiService(table=mock_table)

        result = service.increment_daily_scrape_count('user-123', '2026-03-13')
        assert result == {'count': 1}

        call_kwargs = mock_table.update_item.call_args[1]
        assert call_kwargs['Key'] == {'PK': 'USER#user-123', 'SK': '#DAILY_SCRAPE_COUNT#2026-03-13'}
        # Verify TTL is set
        assert ':ttl' in call_kwargs['ExpressionAttributeValues']

    def test_increment_is_atomic(self):
        mock_table = MagicMock()
        mock_table.update_item.return_value = {'Attributes': {'count': 5}}
        service = DynamoDBApiService(table=mock_table)

        result = service.increment_daily_scrape_count('user-123', '2026-03-13')
        assert result == {'count': 5}
        # Verify ADD expression is used for atomicity
        call_kwargs = mock_table.update_item.call_args[1]
        assert 'ADD' in call_kwargs['UpdateExpression']


class TestImportCheckpoint:
    """Tests for import checkpoint methods."""

    def test_save_creates_item(self):
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        checkpoint = {
            'batchIndex': 2,
            'lastProfileId': 'john-doe',
            'connectionType': 'ally',
            'processedCount': 50,
            'totalCount': 200,
            'updatedAt': '2026-03-13T00:00:00Z',
        }
        result = service.save_import_checkpoint('user-123', checkpoint)
        assert result == {'success': True}

        put_item = mock_table.put_item.call_args[1]['Item']
        assert put_item['PK'] == 'USER#user-123'
        assert put_item['SK'] == '#IMPORT_CHECKPOINT'
        assert put_item['batchIndex'] == 2

    def test_get_returns_saved_data(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'PK': 'USER#user-123',
                'SK': '#IMPORT_CHECKPOINT',
                'batchIndex': 2,
                'lastProfileId': 'john-doe',
            }
        }
        service = DynamoDBApiService(table=mock_table)

        result = service.get_import_checkpoint('user-123')
        assert result['checkpoint']['batchIndex'] == 2
        assert result['checkpoint']['lastProfileId'] == 'john-doe'
        # PK/SK should be stripped
        assert 'PK' not in result['checkpoint']

    def test_get_returns_empty_when_not_found(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        service = DynamoDBApiService(table=mock_table)

        result = service.get_import_checkpoint('user-123')
        assert result == {}

    def test_clear_deletes_item(self):
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.clear_import_checkpoint('user-123')
        assert result == {'success': True}
        mock_table.delete_item.assert_called_once_with(
            Key={'PK': 'USER#user-123', 'SK': '#IMPORT_CHECKPOINT'}
        )


# ---- v1.7 Settings Extensions ----


class TestTimezoneAndDigestSettings:
    """Tests for timezone and digest_opted_out settings fields."""

    def test_update_with_timezone_field(self):
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.update_user_settings('user-123', {'timezone': 'America/New_York'})
        assert result == {'success': True}
        mock_table.update_item.assert_called_once()
        call_kwargs = mock_table.update_item.call_args[1]
        assert ':v_timezone' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':v_timezone'] == 'America/New_York'

    def test_update_with_digest_opted_out_field(self):
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.update_user_settings('user-123', {'digest_opted_out': True})
        assert result == {'success': True}
        mock_table.update_item.assert_called_once()
        call_kwargs = mock_table.update_item.call_args[1]
        assert ':v_digest_opted_out' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':v_digest_opted_out'] is True

    def test_timezone_validation_rejects_long_string(self):
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.update_user_settings('user-123', {'timezone': 'A' * 51})
        assert 'error' in result

    def test_timezone_validation_rejects_non_string(self):
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.update_user_settings('user-123', {'timezone': 12345})
        assert 'error' in result

    def test_digest_opted_out_validation_rejects_non_boolean(self):
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.update_user_settings('user-123', {'digest_opted_out': 'yes'})
        assert 'error' in result

    def test_both_fields_accepted_together(self):
        mock_table = MagicMock()
        service = DynamoDBApiService(table=mock_table)

        result = service.update_user_settings('user-123', {
            'timezone': 'Europe/London',
            'digest_opted_out': False,
        })
        assert result == {'success': True}
        mock_table.update_item.assert_called_once()
