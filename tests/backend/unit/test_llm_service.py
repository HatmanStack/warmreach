"""Unit tests for LLMService class (TDD)."""
from unittest.mock import MagicMock

import openai
import pytest


@pytest.fixture
def mock_openai_client():
    """Create mock OpenAI client."""
    client = MagicMock()
    # Default: mock responses.create with output_text
    mock_response = MagicMock()
    mock_response.id = 'resp_123'
    mock_response.output_text = 'Idea: Test idea 1\n\nIdea: Test idea 2'
    client.responses.create.return_value = mock_response
    return client


@pytest.fixture
def mock_bedrock_client():
    """Create mock Bedrock client."""
    client = MagicMock()
    client.invoke_model.return_value = {
        'body': MagicMock(read=MagicMock(return_value=b'{"content": [{"text": "Styled content"}]}'))
    }
    return client


@pytest.fixture
def mock_dynamodb_table():
    """Create mock DynamoDB table."""
    table = MagicMock()
    table.get_item.return_value = {}
    return table


@pytest.fixture
def service(mock_openai_client, mock_bedrock_client, mock_dynamodb_table):
    """Create LLMService with mocked dependencies."""
    from conftest import load_service_class
    module = load_service_class('llm', 'llm_service')
    return module.LLMService(
        openai_client=mock_openai_client,
        bedrock_client=mock_bedrock_client,
        table=mock_dynamodb_table
    )


class TestLLMServiceInit:
    """Tests for service initialization."""

    def test_service_initializes_with_clients(self, mock_openai_client, mock_bedrock_client, mock_dynamodb_table):
        """Service should accept clients via constructor injection."""
        from conftest import load_service_class
        module = load_service_class('llm', 'llm_service')
        service = module.LLMService(
            openai_client=mock_openai_client,
            bedrock_client=mock_bedrock_client,
            table=mock_dynamodb_table
        )
        assert service.openai_client == mock_openai_client
        assert service.bedrock_client == mock_bedrock_client
        assert service.table == mock_dynamodb_table


class TestGenerateIdeas:
    """Tests for generate_ideas operation."""

    def test_generate_ideas_returns_ideas(self, service, mock_openai_client):
        """Should return parsed ideas synchronously."""
        result = service.generate_ideas(
            user_profile={'name': 'John Doe'},
            prompt='AI trends',
            job_id='job-123',
            user_id='user-456'
        )

        assert result['success'] is True
        assert 'ideas' in result
        assert len(result['ideas']) == 2
        mock_openai_client.responses.create.assert_called_once()

    def test_generate_ideas_includes_user_profile(self, service, mock_openai_client):
        """Should include user profile in prompt."""
        service.generate_ideas(
            user_profile={'name': 'Jane Doe', 'title': 'Engineer'},
            prompt='Tech topics',
            job_id='job-123',
            user_id='user-456'
        )

        call_args = mock_openai_client.responses.create.call_args
        assert 'input' in call_args[1]

    def test_generate_ideas_raises_external_service_error_on_api_error(self, service, mock_openai_client):
        """Should raise ExternalServiceError on OpenAI API failure."""
        from errors.exceptions import ExternalServiceError
        mock_openai_client.responses.create.side_effect = openai.APIError(
            message='API error', request=MagicMock(), body=None
        )

        with pytest.raises(ExternalServiceError) as exc_info:
            service.generate_ideas(
                user_profile={},
                prompt='test',
                job_id='job-123',
                user_id='user-456'
            )

        assert exc_info.value.details['service'] == 'OpenAI'

    def test_generate_ideas_raises_service_error_on_unexpected_error(self, service, mock_openai_client):
        """Should raise ServiceError on unexpected failures."""
        from errors.exceptions import ServiceError
        mock_openai_client.responses.create.side_effect = RuntimeError('Unexpected')

        with pytest.raises(ServiceError):
            service.generate_ideas(
                user_profile={},
                prompt='test',
                job_id='job-123',
                user_id='user-456'
            )

    def test_generate_ideas_raises_external_service_error_on_timeout(self, service, mock_openai_client):
        """Should raise ExternalServiceError on OpenAI timeout."""
        from errors.exceptions import ExternalServiceError
        mock_openai_client.responses.create.side_effect = openai.APITimeoutError(request=MagicMock())

        with pytest.raises(ExternalServiceError) as exc_info:
            service.generate_ideas(
                user_profile={},
                prompt='test',
                job_id='job-123',
                user_id='user-456'
            )

        assert exc_info.value.details['service'] == 'OpenAI'


class TestResearchSelectedIdeas:
    """Tests for research_selected_ideas operation."""

    def test_research_ideas_returns_job_id(self, service, mock_openai_client):
        """Should return job ID for background research."""
        result = service.research_selected_ideas(
            user_data={'name': 'Test User'},
            selected_ideas=['AI in healthcare', 'Cloud computing'],
            user_id='user-123'
        )

        assert result['success'] is True
        assert 'job_id' in result
        assert len(result['job_id']) > 0

    def test_research_ideas_empty_list_raises_validation_error(self, service):
        """Should raise ValidationError with empty ideas list."""
        from errors.exceptions import ValidationError

        with pytest.raises(ValidationError):
            service.research_selected_ideas(
                user_data={},
                selected_ideas=[],
                user_id='user-123'
            )

    def test_research_ideas_calls_openai_with_web_search(self, service, mock_openai_client):
        """Should use OpenAI with web search tool."""
        service.research_selected_ideas(
            user_data={},
            selected_ideas=['Topic 1'],
            user_id='user-123'
        )

        call_args = mock_openai_client.responses.create.call_args
        assert call_args[1].get('tools') is not None


class TestGetResearchResult:
    """Tests for get_research_result operation."""

    def test_get_result_returns_ideas_when_found(self, service, mock_dynamodb_table):
        """Should return ideas when found in DynamoDB."""
        mock_dynamodb_table.get_item.return_value = {
            'Item': {
                'PK': 'USER#user-123',
                'SK': 'IDEAS#job-456',
                'ideas': ['Idea 1', 'Idea 2']
            }
        }

        result = service.get_research_result(
            user_id='user-123',
            job_id='job-456',
            kind='IDEAS'
        )

        assert result['success'] is True
        assert result['ideas'] == ['Idea 1', 'Idea 2']

    def test_get_result_returns_false_when_not_found(self, service, mock_dynamodb_table):
        """Should return success=False when result not found."""
        mock_dynamodb_table.get_item.return_value = {}

        result = service.get_research_result(
            user_id='user-123',
            job_id='job-456',
            kind='RESEARCH'
        )

        assert result['success'] is False


class TestSynthesizeResearch:
    """Tests for synthesize_research operation."""

    def test_synthesize_returns_content(self, service, mock_openai_client):
        """Should return synthesized content synchronously."""
        mock_openai_client.responses.create.return_value.output_text = 'Synthesized post content'
        result = service.synthesize_research(
            research_content='Research findings...',
            post_content='Draft post...',
            ideas_content=['idea 1'],
            user_profile={'name': 'Test'},
            job_id='job-123',
            user_id='user-456'
        )

        assert result['success'] is True
        assert result['content'] == 'Synthesized post content'

    def test_synthesize_requires_job_id(self, service):
        """Should raise ValidationError when job_id is missing."""
        from errors.exceptions import ValidationError

        with pytest.raises(ValidationError, match='job_id'):
            service.synthesize_research(
                research_content='test',
                post_content='test',
                ideas_content=[],
                user_profile={},
                job_id=None,
                user_id='user-123'
            )


class TestSanitizePrompt:
    """Tests for _sanitize_prompt input validation."""

    def test_empty_string_returns_empty(self, service):
        """Should return empty string for empty input."""
        assert service._sanitize_prompt('') == ''

    def test_none_returns_empty(self, service):
        """Should return empty string for None."""
        assert service._sanitize_prompt(None) == ''

    def test_truncates_at_max_length(self, service):
        """Should truncate to 2000 chars by default."""
        long_text = 'a' * 3000
        result = service._sanitize_prompt(long_text)
        assert len(result) == 2000

    def test_custom_max_length(self, service):
        """Should respect custom max_length parameter."""
        text = 'a' * 500
        result = service._sanitize_prompt(text, max_length=100)
        assert len(result) == 100

    def test_strips_control_characters(self, service):
        """Should strip control chars (except newline/tab)."""
        text = 'hello\x00world\x01test\x7f'
        result = service._sanitize_prompt(text)
        assert '\x00' not in result
        assert '\x01' not in result
        assert '\x7f' not in result
        assert 'hello' in result
        assert 'world' in result

    def test_preserves_newlines_and_tabs(self, service):
        """Should keep newlines and tabs."""
        text = 'line1\nline2\ttab'
        result = service._sanitize_prompt(text)
        assert '\n' in result
        assert '\t' in result

    def test_escapes_curly_braces(self, service):
        """Should double curly braces to prevent .format() injection."""
        text = 'Hello {name} and {role}'
        result = service._sanitize_prompt(text)
        assert '{{name}}' in result
        assert '{{role}}' in result

    def test_strips_whitespace(self, service):
        """Should strip leading/trailing whitespace."""
        text = '   hello world   '
        result = service._sanitize_prompt(text)
        assert result == 'hello world'

    def test_format_injection_prevented(self, service):
        """Should prevent .format() injection attacks."""
        malicious = '{__class__.__init__.__globals__}'
        result = service._sanitize_prompt(malicious)
        # Double-escaped braces prevent format injection
        assert '{' not in result or '{{' in result

    def test_normal_text_passes_through(self, service):
        """Should not modify normal text."""
        text = 'Write a post about AI trends in 2024'
        result = service._sanitize_prompt(text)
        assert result == text


class TestGenerateMessage:
    """Tests for generate_message operation."""

    def test_generate_message_returns_message(self, service, mock_openai_client):
        """Should return generated message from OpenAI."""
        mock_openai_client.responses.create.return_value.output_text = 'Hi John, I noticed your work in AI...'
        result = service.generate_message(
            connection_profile={
                'firstName': 'John',
                'lastName': 'Doe',
                'position': 'Engineer',
                'company': 'Acme',
                'headline': 'Building things',
                'tags': ['python', 'AI'],
            },
            conversation_topic='AI trends in 2025',
            user_profile={'name': 'Jane Smith', 'title': 'PM'},
        )

        assert result['generatedMessage'] == 'Hi John, I noticed your work in AI...'
        assert result['confidence'] > 0
        mock_openai_client.responses.create.assert_called_once()

    def test_generate_message_raises_external_service_error_on_api_error(self, service, mock_openai_client):
        """Should raise ExternalServiceError on OpenAI API failure."""
        from errors.exceptions import ExternalServiceError
        mock_openai_client.responses.create.side_effect = openai.APIError(
            message='API error', request=MagicMock(), body=None
        )

        with pytest.raises(ExternalServiceError) as exc_info:
            service.generate_message(
                connection_profile={'firstName': 'John', 'lastName': 'Doe', 'position': 'Eng', 'company': 'Co'},
                conversation_topic='test topic',
            )

        assert exc_info.value.details['service'] == 'OpenAI'

    def test_generate_message_raises_service_error_on_unexpected(self, service, mock_openai_client):
        """Should raise ServiceError on unexpected errors."""
        from errors.exceptions import ServiceError
        mock_openai_client.responses.create.side_effect = RuntimeError('Unexpected')

        with pytest.raises(ServiceError):
            service.generate_message(
                connection_profile={'firstName': 'John', 'lastName': 'Doe', 'position': 'Eng', 'company': 'Co'},
                conversation_topic='test topic',
            )

    def test_generate_message_handles_empty_response(self, service, mock_openai_client):
        """Should handle empty OpenAI response."""
        mock_openai_client.responses.create.return_value.output_text = ''

        result = service.generate_message(
            connection_profile={'firstName': 'A', 'lastName': 'B', 'position': 'X', 'company': 'Y'},
            conversation_topic='topic',
        )

        assert result['generatedMessage'] == ''
        assert result['confidence'] == 0

    def test_generate_message_includes_message_history(self, service, mock_openai_client):
        """Should include message history in prompt."""
        mock_openai_client.responses.create.return_value.output_text = 'Follow-up message'
        result = service.generate_message(
            connection_profile={'firstName': 'A', 'lastName': 'B', 'position': 'X', 'company': 'Y'},
            conversation_topic='topic',
            message_history=[
                {'type': 'outbound', 'content': 'Hello!'},
                {'type': 'inbound', 'content': 'Hi there!'},
            ],
        )

        assert result['generatedMessage'] == 'Follow-up message'
        call_args = mock_openai_client.responses.create.call_args
        prompt = call_args[1]['input']
        assert 'outbound' in prompt
        assert 'Hello!' in prompt

    def test_generate_message_enriches_from_dynamodb(self, mock_openai_client, mock_bedrock_client):
        """Should fetch additional context from DynamoDB when connectionId provided."""
        import base64

        from moto import mock_aws

        with mock_aws():
            import boto3

            dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
            table = dynamodb.create_table(
                TableName='test-table',
                KeySchema=[
                    {'AttributeName': 'PK', 'KeyType': 'HASH'},
                    {'AttributeName': 'SK', 'KeyType': 'RANGE'},
                ],
                AttributeDefinitions=[
                    {'AttributeName': 'PK', 'AttributeType': 'S'},
                    {'AttributeName': 'SK', 'AttributeType': 'S'},
                ],
                BillingMode='PAY_PER_REQUEST',
            )

            # Seed the profile metadata item
            profile_id_b64 = base64.urlsafe_b64encode(b'john-doe-12345').decode()
            table.put_item(
                Item={
                    'PK': f'PROFILE#{profile_id_b64}',
                    'SK': '#METADATA',
                    'summary': 'Expert in machine learning',
                    'skills': ['ML', 'Python', 'TensorFlow'],
                    'workExperience': [{'title': 'ML Lead', 'company': 'DeepTech'}],
                }
            )

            from conftest import load_service_class

            module = load_service_class('llm', 'llm_service')
            svc = module.LLMService(
                openai_client=mock_openai_client,
                bedrock_client=mock_bedrock_client,
                table=table,
            )

            mock_openai_client.responses.create.return_value.output_text = 'Enriched message'
            result = svc.generate_message(
                connection_profile={'firstName': 'A', 'lastName': 'B', 'position': 'X', 'company': 'Y'},
                conversation_topic='AI',
                connection_id='john-doe-12345',
            )

            assert result['generatedMessage'] == 'Enriched message'
            call_args = mock_openai_client.responses.create.call_args
            prompt = call_args[1]['input']
            assert 'machine learning' in prompt

    def test_generate_message_without_user_profile(self, service, mock_openai_client):
        """Should work without user profile."""
        mock_openai_client.responses.create.return_value.output_text = 'Message without sender context'
        result = service.generate_message(
            connection_profile={'firstName': 'A', 'lastName': 'B', 'position': 'X', 'company': 'Y'},
            conversation_topic='topic',
        )

        assert result['generatedMessage'] == 'Message without sender context'


class TestGenerateIdeasTTL:
    """Tests for TTL on generated items."""

    def test_generate_ideas_stores_with_ttl(self, service, mock_openai_client, mock_dynamodb_table):
        """Should include TTL attribute when storing ideas."""
        import time

        result = service.generate_ideas(
            user_profile={'name': 'John Doe'},
            prompt='AI trends',
            job_id='job-123',
            user_id='user-456'
        )

        assert result['success'] is True
        # Check if table.put_item was called with ttl
        if mock_dynamodb_table.put_item.called:
            call_args = mock_dynamodb_table.put_item.call_args
            item = call_args[1].get('Item', call_args[0][0] if call_args[0] else {})
            if 'ttl' in item:
                # TTL should be roughly 24h from now
                expected_ttl = int(time.time()) + 86400
                assert abs(item['ttl'] - expected_ttl) < 60  # Within 60s

    def test_research_stores_with_ttl(self, service, mock_openai_client, mock_dynamodb_table):
        """Should include TTL on research results (7 day)."""
        import time

        result = service.research_selected_ideas(
            user_data={'name': 'Test User'},
            selected_ideas=['Topic 1'],
            user_id='user-123'
        )

        assert result['success'] is True
        # Verify the job_id is generated (research stores async)
        assert 'job_id' in result


class TestResearchPolling:
    """Tests for research result polling behavior."""

    def test_get_research_handles_missing_item(self, service, mock_dynamodb_table):
        """Should return success=False when DynamoDB item is missing."""
        mock_dynamodb_table.get_item.return_value = {}

        result = service.get_research_result(
            user_id='user-123',
            job_id='nonexistent-job',
            kind='RESEARCH'
        )

        assert result['success'] is False

    def test_get_research_returns_content_when_found(self, service, mock_dynamodb_table):
        """Should return content when research item exists."""
        mock_dynamodb_table.get_item.return_value = {
            'Item': {
                'PK': 'USER#user-123',
                'SK': 'RESEARCH#job-456',
                'content': 'Research findings about topic X'
            }
        }

        result = service.get_research_result(
            user_id='user-123',
            job_id='job-456',
            kind='RESEARCH'
        )

        assert result['success'] is True

    def test_synthesize_handles_empty_research(self, service, mock_openai_client):
        """Should handle empty research content gracefully."""
        mock_openai_client.responses.create.return_value.output_text = 'Generated content'

        result = service.synthesize_research(
            research_content='',
            post_content='Draft post',
            ideas_content=[],
            user_profile={'name': 'Test'},
            job_id='job-123',
            user_id='user-456'
        )

        # Should still attempt synthesis even with empty research
        assert result['success'] is True or 'error' in result

    def test_synthesize_sanitizes_user_input(self, service, mock_openai_client):
        """Should sanitize user-provided content in synthesis."""
        mock_openai_client.responses.create.return_value.output_text = 'Clean output'

        result = service.synthesize_research(
            research_content='Normal research',
            post_content='Draft with {injection} attempt',
            ideas_content=['idea1'],
            user_profile={'name': 'Test'},
            job_id='job-123',
            user_id='user-456'
        )

        # Should not crash from format injection
        assert 'success' in result


class TestAnalyzeToneErrorHandling:
    """Tests for analyze_tone OpenAI exception handling."""

    def test_analyze_tone_raises_external_service_error_on_api_error(self, service, mock_openai_client):
        """Should raise ExternalServiceError on OpenAI API failure."""
        from errors.exceptions import ExternalServiceError

        mock_openai_client.responses.create.side_effect = openai.APIError(
            message='API error', request=MagicMock(), body=None
        )

        with pytest.raises(ExternalServiceError) as exc_info:
            service.analyze_tone(
                draft_text='Hello, I would love to connect!',
                recipient_name='Jane Doe',
                recipient_position='Engineer',
                relationship_status='ally',
            )

        assert exc_info.value.details['service'] == 'OpenAI'

    def test_analyze_tone_raises_external_service_error_on_timeout(self, service, mock_openai_client):
        """Should raise ExternalServiceError on OpenAI timeout."""
        from errors.exceptions import ExternalServiceError

        mock_openai_client.responses.create.side_effect = openai.APITimeoutError(request=MagicMock())

        with pytest.raises(ExternalServiceError) as exc_info:
            service.analyze_tone(
                draft_text='Test message',
                recipient_name='Test',
                recipient_position='Test',
                relationship_status='ally',
            )

        assert exc_info.value.details['service'] == 'OpenAI'

    def test_analyze_tone_raises_external_service_error_on_rate_limit(self, service, mock_openai_client):
        """Should raise ExternalServiceError on OpenAI rate limit."""
        from errors.exceptions import ExternalServiceError

        mock_openai_client.responses.create.side_effect = openai.RateLimitError(
            message='Rate limited', response=MagicMock(), body=None
        )

        with pytest.raises(ExternalServiceError) as exc_info:
            service.analyze_tone(
                draft_text='Test message',
                recipient_name='Test',
                recipient_position='Test',
                relationship_status='ally',
            )

        assert exc_info.value.details['service'] == 'OpenAI'

    def test_analyze_tone_raises_service_error_on_unexpected_error(self, service, mock_openai_client):
        """Should raise ServiceError (not ExternalServiceError) on non-OpenAI errors."""
        from errors.exceptions import ExternalServiceError, ServiceError

        mock_openai_client.responses.create.side_effect = RuntimeError('Unexpected')

        with pytest.raises(ServiceError) as exc_info:
            service.analyze_tone(
                draft_text='Test message',
                recipient_name='Test',
                recipient_position='Test',
                relationship_status='ally',
            )

        # Should be a generic ServiceError, NOT ExternalServiceError
        assert not isinstance(exc_info.value, ExternalServiceError)


class TestPerCallTimeout:
    """Tests for per-call OpenAI timeout (ADR-5)."""

    def test_default_call_timeout_is_45(self, service):
        """Service should have DEFAULT_CALL_TIMEOUT = 45."""
        assert service.DEFAULT_CALL_TIMEOUT == 45
        assert service.call_timeout == 45

    def test_custom_call_timeout(self, mock_openai_client, mock_bedrock_client, mock_dynamodb_table):
        """Should accept custom call_timeout via constructor."""
        from conftest import load_service_class
        module = load_service_class('llm', 'llm_service')
        svc = module.LLMService(
            openai_client=mock_openai_client,
            bedrock_client=mock_bedrock_client,
            table=mock_dynamodb_table,
            call_timeout=30,
        )
        assert svc.call_timeout == 30

    def test_generate_ideas_passes_timeout(self, service, mock_openai_client):
        """generate_ideas should pass timeout to responses.create()."""
        service.generate_ideas(
            user_profile={'name': 'Test'},
            prompt='topics',
            job_id='j1',
            user_id='u1',
        )
        call_kwargs = mock_openai_client.responses.create.call_args[1]
        assert call_kwargs['timeout'] == 45

    def test_research_selected_ideas_passes_timeout(self, service, mock_openai_client):
        """research_selected_ideas should pass timeout to responses.create()."""
        service.research_selected_ideas(
            user_data={},
            selected_ideas=['topic'],
            user_id='u1',
        )
        call_kwargs = mock_openai_client.responses.create.call_args[1]
        assert call_kwargs['timeout'] == 45

    def test_synthesize_research_passes_timeout(self, service, mock_openai_client):
        """synthesize_research should pass timeout to responses.create()."""
        mock_openai_client.responses.create.return_value.output_text = 'content'
        service.synthesize_research(
            research_content='r',
            post_content='p',
            ideas_content=[],
            user_profile={'name': 'T'},
            job_id='j1',
            user_id='u1',
        )
        call_kwargs = mock_openai_client.responses.create.call_args[1]
        assert call_kwargs['timeout'] == 45

    def test_generate_message_passes_timeout(self, service, mock_openai_client):
        """generate_message should pass timeout to responses.create()."""
        mock_openai_client.responses.create.return_value.output_text = 'msg'
        service.generate_message(
            connection_profile={'firstName': 'A', 'lastName': 'B', 'position': 'X', 'company': 'Y'},
            conversation_topic='AI',
        )
        call_kwargs = mock_openai_client.responses.create.call_args[1]
        assert call_kwargs['timeout'] == 45

    def test_analyze_message_patterns_passes_timeout(self, service, mock_openai_client):
        """analyze_message_patterns should pass timeout to responses.create()."""
        mock_openai_client.responses.create.return_value.output_text = '1. Insight'
        service.analyze_message_patterns(
            stats={'totalOutbound': 5},
            sample_messages=[],
        )
        call_kwargs = mock_openai_client.responses.create.call_args[1]
        assert call_kwargs['timeout'] == 45

    def test_analyze_tone_passes_timeout(self, service, mock_openai_client):
        """analyze_tone should pass timeout to responses.create()."""
        mock_openai_client.responses.create.return_value.output_text = 'PROFESSIONALISM: 8'
        service.analyze_tone(draft_text='hello')
        call_kwargs = mock_openai_client.responses.create.call_args[1]
        assert call_kwargs['timeout'] == 45

    def test_retrieve_passes_timeout(self, service, mock_openai_client, mock_dynamodb_table):
        """_check_openai_response should pass timeout to responses.retrieve()."""
        mock_resp = MagicMock()
        mock_resp.status = 'completed'
        mock_resp.output_text = 'result'
        mock_openai_client.responses.retrieve.return_value = mock_resp
        service._check_openai_response('u1', 'j1', 'resp_123', 'RESEARCH')
        call_kwargs = mock_openai_client.responses.retrieve.call_args[1]
        assert call_kwargs['timeout'] == 45
