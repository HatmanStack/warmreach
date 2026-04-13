"""Integration tests for LLMService with mocked services."""
import pytest
from moto import mock_aws
from unittest.mock import MagicMock

from conftest import load_service_class


@pytest.fixture
def llm_service_module():
    """Load LLMService module."""
    return load_service_class('llm', 'llm_service')


class TestLLMServiceIntegration:
    """Integration tests for LLMService with mocked OpenAI/Bedrock/DynamoDB."""

    @mock_aws
    def test_generate_ideas_returns_ideas(self, llm_service_module):
        """Test idea generation returns ideas synchronously."""
        mock_openai = MagicMock()
        mock_response = MagicMock()
        mock_response.output_text = 'Idea: Test idea 1\n\nIdea: Test idea 2'
        mock_openai.responses.create.return_value = mock_response

        service = llm_service_module.LLMService(
            openai_client=mock_openai,
            bedrock_client=MagicMock(),
            table=None
        )

        result = service.generate_ideas(
            user_profile={'name': 'Test User'},
            prompt='AI trends',
            job_id='job-123',
            user_id='user-456'
        )

        assert result['success'] is True
        assert 'ideas' in result
        mock_openai.responses.create.assert_called_once()

    @mock_aws
    def test_research_ideas_returns_job_id(self, llm_service_module):
        """Test research ideas returns job ID."""
        mock_openai = MagicMock()
        mock_openai.responses.create.return_value = MagicMock(id='resp_123')

        service = llm_service_module.LLMService(
            openai_client=mock_openai,
            bedrock_client=MagicMock(),
            table=None
        )

        result = service.research_selected_ideas(
            user_data={'name': 'Test'},
            selected_ideas=['AI in healthcare', 'Cloud computing'],
            user_id='user-123'
        )

        assert result['success'] is True
        assert 'job_id' in result
        assert len(result['job_id']) > 0

    @mock_aws
    def test_get_research_result_from_dynamodb(self, llm_service_module):
        """Test retrieving research result from DynamoDB."""
        import boto3

        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        table = dynamodb.create_table(
            TableName='test-table',
            KeySchema=[
                {'AttributeName': 'PK', 'KeyType': 'HASH'},
                {'AttributeName': 'SK', 'KeyType': 'RANGE'}
            ],
            AttributeDefinitions=[
                {'AttributeName': 'PK', 'AttributeType': 'S'},
                {'AttributeName': 'SK', 'AttributeType': 'S'},
            ],
            BillingMode='PAY_PER_REQUEST'
        )

        # Insert test data
        table.put_item(Item={
            'PK': 'USER#user-123',
            'SK': 'IDEAS#job-456',
            'ideas': ['Idea 1', 'Idea 2', 'Idea 3']
        })

        service = llm_service_module.LLMService(
            openai_client=MagicMock(),
            bedrock_client=MagicMock(),
            table=table
        )

        result = service.get_research_result(
            user_id='user-123',
            job_id='job-456',
            kind='IDEAS'
        )

        assert result['success'] is True
        assert result['ideas'] == ['Idea 1', 'Idea 2', 'Idea 3']


    @mock_aws
    def test_synthesize_research_returns_content(self, llm_service_module):
        """Test research synthesis returns content synchronously."""
        mock_openai = MagicMock()
        mock_response = MagicMock()
        mock_response.output_text = 'Synthesized content about the research'
        mock_openai.responses.create.return_value = mock_response

        service = llm_service_module.LLMService(
            openai_client=mock_openai,
            bedrock_client=MagicMock(),
            table=None
        )

        result = service.synthesize_research(
            research_content='Research findings...',
            post_content='Draft post...',
            ideas_content=['idea 1'],
            user_profile={'name': 'Test'},
            job_id='job-789',
            user_id='user-456'
        )

        assert result['success'] is True
        assert 'content' in result
        mock_openai.responses.create.assert_called()
