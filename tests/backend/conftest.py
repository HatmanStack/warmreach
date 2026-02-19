"""
Pytest configuration and fixtures for Lambda function testing
"""
import importlib.util
import os
import sys
from pathlib import Path

import pytest
from moto import mock_aws

# Path to lambdas directory
BACKEND_LAMBDAS = Path(__file__).parent.parent.parent / 'backend' / 'lambdas'

# Path to shared python modules
SHARED_PYTHON = BACKEND_LAMBDAS / 'shared' / 'python'

# Path to edge-processing services
EDGE_PROCESSING = BACKEND_LAMBDAS / 'edge-processing'

# Add shared python path to sys.path for imports
sys.path.insert(0, str(SHARED_PYTHON))

# Add Lambda-specific paths for service imports
# We use a helper function to load Lambda services
EDGE_PROCESSING_SERVICES = BACKEND_LAMBDAS / 'edge-processing' / 'services'
LLM_SERVICES = BACKEND_LAMBDAS / 'llm' / 'services'

# Set test environment variables before any Lambda imports
os.environ['DYNAMODB_TABLE_NAME'] = 'test-table'
os.environ['TABLE_NAME'] = 'test-table'
os.environ['BUCKET_NAME'] = 'test-bucket'
os.environ['LOG_LEVEL'] = 'DEBUG'
os.environ['COGNITO_USER_POOL_ID'] = 'test-pool-id'
os.environ['COGNITO_REGION'] = 'us-west-2'
os.environ['ALLOWED_ORIGINS'] = 'http://localhost:5173,http://localhost:3000'
os.environ['OPENAI_API_KEY'] = 'test-key-for-unit-tests'


def load_lambda_module(lambda_name: str):
    """
    Load a Lambda module with proper isolation to avoid caching conflicts.

    Args:
        lambda_name: Name of the Lambda directory (e.g., 'dynamodb-api', 'edge-processing')

    Returns:
        The loaded lambda_function module
    """
    lambda_path = BACKEND_LAMBDAS / lambda_name / 'lambda_function.py'

    if not lambda_path.exists():
        raise FileNotFoundError(f"Lambda function not found: {lambda_path}")

    # Create a unique module name to avoid caching conflicts
    module_name = f"lambda_{lambda_name.replace('-', '_')}"

    # Load the module spec
    spec = importlib.util.spec_from_file_location(module_name, lambda_path)
    module = importlib.util.module_from_spec(spec)

    # Paths for imports - both shared and Lambda-specific
    lambda_dir = str(BACKEND_LAMBDAS / lambda_name)
    shared_dir = str(SHARED_PYTHON)

    # Save original path state
    original_path = sys.path.copy()

    # Clear any cached module imports that might conflict
    for mod_name in list(sys.modules.keys()):
        if mod_name.startswith(('services', 'errors', 'models', 'shared_services')):
            del sys.modules[mod_name]

    # Build clean path with shared FIRST, then lambda-specific
    # This ensures shared modules (services.base_service, errors, models) are found first
    # But lambda-specific services (edge_service) are also available
    clean_path = [shared_dir, lambda_dir]
    for p in original_path:
        if p not in clean_path:
            clean_path.append(p)

    sys.path[:] = clean_path

    try:
        spec.loader.exec_module(module)
    finally:
        # Restore original path
        sys.path[:] = original_path

    return module


def load_service_class(lambda_name: str, service_name: str):
    """
    Load a service class from a Lambda's services directory.

    Args:
        lambda_name: Name of the Lambda directory (e.g., 'edge-processing')
        service_name: Name of the service module (e.g., 'edge_service')

    Returns:
        The service module (access class via module.ClassName)
    """
    service_path = BACKEND_LAMBDAS / lambda_name / 'services' / f'{service_name}.py'

    if not service_path.exists():
        raise FileNotFoundError(f"Service not found: {service_path}")

    # Create a unique module name
    module_name = f"service_{lambda_name.replace('-', '_')}_{service_name}"

    # Load the module spec
    spec = importlib.util.spec_from_file_location(module_name, service_path)
    module = importlib.util.module_from_spec(spec)

    # Paths for imports
    lambda_dir = str(BACKEND_LAMBDAS / lambda_name)
    shared_dir = str(SHARED_PYTHON)

    # Save original path state
    original_path = sys.path.copy()

    # Clear any cached module imports that might conflict
    for mod_name in list(sys.modules.keys()):
        if mod_name.startswith(('services', 'errors', 'models', 'shared_services')):
            del sys.modules[mod_name]

    # Build clean path with shared FIRST, then lambda-specific
    # This ensures shared modules (services.base_service, errors, models) are found first
    clean_path = [shared_dir, lambda_dir]
    for p in original_path:
        if p not in clean_path:
            clean_path.append(p)

    sys.path[:] = clean_path

    try:
        spec.loader.exec_module(module)
    finally:
        # Restore original path
        sys.path[:] = original_path

    return module


@pytest.fixture(scope='session', autouse=True)
def aws_credentials():
    """Set up fake AWS credentials for testing"""
    os.environ['AWS_ACCESS_KEY_ID'] = 'testing'
    os.environ['AWS_SECRET_ACCESS_KEY'] = 'testing'
    os.environ['AWS_SECURITY_TOKEN'] = 'testing'
    os.environ['AWS_SESSION_TOKEN'] = 'testing'
    os.environ['AWS_DEFAULT_REGION'] = 'us-east-1'


@pytest.fixture
def mock_env_vars():
    """Set common environment variables for Lambda functions"""
    original_env = os.environ.copy()

    os.environ['TABLE_NAME'] = 'test-table'
    os.environ['BUCKET_NAME'] = 'test-bucket'
    os.environ['REGION'] = 'us-east-1'

    yield

    # Restore original environment
    os.environ.clear()
    os.environ.update(original_env)


@pytest.fixture
def dynamodb_table(aws_credentials):
    """Create a mock DynamoDB table for testing"""
    with mock_aws():
        import boto3

        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')

        # Create test table
        table = dynamodb.create_table(
            TableName='test-table',
            KeySchema=[
                {'AttributeName': 'PK', 'KeyType': 'HASH'},
                {'AttributeName': 'SK', 'KeyType': 'RANGE'}
            ],
            AttributeDefinitions=[
                {'AttributeName': 'PK', 'AttributeType': 'S'},
                {'AttributeName': 'SK', 'AttributeType': 'S'},
                {'AttributeName': 'GSI1PK', 'AttributeType': 'S'},
                {'AttributeName': 'GSI1SK', 'AttributeType': 'S'},
            ],
            GlobalSecondaryIndexes=[
                {
                    'IndexName': 'GSI1',
                    'KeySchema': [
                        {'AttributeName': 'GSI1PK', 'KeyType': 'HASH'},
                        {'AttributeName': 'GSI1SK', 'KeyType': 'RANGE'},
                    ],
                    'Projection': {'ProjectionType': 'ALL'},
                    'ProvisionedThroughput': {
                        'ReadCapacityUnits': 5,
                        'WriteCapacityUnits': 5
                    }
                }
            ],
            ProvisionedThroughput={
                'ReadCapacityUnits': 5,
                'WriteCapacityUnits': 5
            }
        )

        yield table


@pytest.fixture
def s3_bucket(aws_credentials):
    """Create a mock S3 bucket for testing"""
    with mock_aws():
        import boto3

        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='test-bucket')

        yield s3


@pytest.fixture
def api_gateway_event():
    """Create a mock API Gateway event"""
    return {
        'httpMethod': 'GET',
        'path': '/test',
        'headers': {
            'Content-Type': 'application/json',
        },
        'queryStringParameters': None,
        'pathParameters': None,
        'body': None,
        'isBase64Encoded': False,
        'requestContext': {
            'requestId': 'test-request-id',
            'identity': {
                'sourceIp': '127.0.0.1',
            },
        },
    }


@pytest.fixture
def lambda_context():
    """Create a mock Lambda context"""
    class MockContext:
        def __init__(self):
            self.function_name = 'test-function'
            self.function_version = '1'
            self.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789012:function:test'
            self.memory_limit_in_mb = '128'
            self.aws_request_id = 'test-request-id'
            self.log_group_name = '/aws/lambda/test'
            self.log_stream_name = '2024/01/01/[$LATEST]test'

        def get_remaining_time_in_millis(self):
            return 3000

    return MockContext()


# =============================================================================
# MOTO FIXTURES FOR INTEGRATION TESTS
# =============================================================================

@pytest.fixture
def mock_lambda_client(aws_credentials):
    """
    Create a mock Lambda client for testing inter-Lambda invocations.

    Usage:
        def test_lambda_invocation(mock_lambda_client):
            # mock_lambda_client is a boto3 Lambda client within moto context
            pass
    """
    with mock_aws():
        import boto3

        lambda_client = boto3.client('lambda', region_name='us-east-1')
        yield lambda_client


@pytest.fixture
def mock_dynamodb_resource(aws_credentials):
    """
    Create a mock DynamoDB resource with table for testing.

    Usage:
        def test_dynamodb(mock_dynamodb_resource):
            table = mock_dynamodb_resource['table']
            dynamodb = mock_dynamodb_resource['resource']
    """
    with mock_aws():
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
                {'AttributeName': 'GSI1PK', 'AttributeType': 'S'},
                {'AttributeName': 'GSI1SK', 'AttributeType': 'S'},
            ],
            GlobalSecondaryIndexes=[
                {
                    'IndexName': 'GSI1',
                    'KeySchema': [
                        {'AttributeName': 'GSI1PK', 'KeyType': 'HASH'},
                        {'AttributeName': 'GSI1SK', 'KeyType': 'RANGE'},
                    ],
                    'Projection': {'ProjectionType': 'ALL'},
                    'ProvisionedThroughput': {
                        'ReadCapacityUnits': 5,
                        'WriteCapacityUnits': 5
                    }
                }
            ],
            ProvisionedThroughput={
                'ReadCapacityUnits': 5,
                'WriteCapacityUnits': 5
            }
        )

        yield {'table': table, 'resource': dynamodb}


@pytest.fixture
def mock_s3_client(aws_credentials):
    """
    Create a mock S3 client with bucket for testing.

    Usage:
        def test_s3(mock_s3_client):
            mock_s3_client.put_object(Bucket='test-bucket', Key='test.txt', Body=b'data')
    """
    with mock_aws():
        import boto3

        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='test-bucket')

        yield s3


# =============================================================================
# FACTORY FUNCTIONS FOR TEST DATA
# =============================================================================

@pytest.fixture
def create_test_edge():
    """
    Factory fixture for creating test edge items.

    Usage:
        def test_something(create_test_edge):
            edge = create_test_edge(user_id='user1', profile_id='profile1')
    """
    def _create_edge(
        user_id: str = 'test-user-123',
        profile_id: str = 'test-profile-456',
        status: str = 'possible',
        connection_attempts: int = 0,
        date_added: str | None = None,
        **kwargs
    ) -> dict:
        from datetime import UTC, datetime

        edge = {
            'PK': f'USER#{user_id}',
            'SK': f'EDGE#{profile_id}',
            'user_id': user_id,
            'profile_id': profile_id,
            'status': status,
            'connection_attempts': connection_attempts,
            'date_added': date_added or datetime.now(UTC).isoformat(),
            'GSI1PK': f'STATUS#{status}',
            'GSI1SK': f'USER#{user_id}#EDGE#{profile_id}',
        }
        edge.update(kwargs)
        return edge

    return _create_edge


@pytest.fixture
def create_test_profile():
    """
    Factory fixture for creating test profile items.

    Usage:
        def test_something(create_test_profile):
            profile = create_test_profile(first_name='John', last_name='Doe')
    """
    def _create_profile(
        profile_id: str = 'test-profile-456',
        first_name: str = 'Test',
        last_name: str = 'User',
        headline: str = 'Software Engineer',
        summary: str = 'Experienced developer',
        company: str = 'Test Corp',
        **kwargs
    ) -> dict:
        profile = {
            'PK': f'PROFILE#{profile_id}',
            'SK': 'METADATA',
            'profile_id': profile_id,
            'first_name': first_name,
            'last_name': last_name,
            'headline': headline,
            'summary': summary,
            'company': company,
        }
        profile.update(kwargs)
        return profile

    return _create_profile


@pytest.fixture
def create_authenticated_event():
    """
    Factory fixture for creating authenticated API Gateway events.

    Usage:
        def test_something(create_authenticated_event):
            event = create_authenticated_event(
                user_id='user123',
                body={'operation': 'get_connections'}
            )
    """
    import json

    def _create_event(
        user_id: str = 'test-user-123',
        body: dict | None = None,
        http_method: str = 'POST',
        path: str = '/edges',
        **kwargs
    ) -> dict:
        event = {
            'httpMethod': http_method,
            'path': path,
            'headers': {
                'Content-Type': 'application/json',
            },
            'queryStringParameters': None,
            'pathParameters': None,
            'body': json.dumps(body) if body else None,
            'isBase64Encoded': False,
            'requestContext': {
                'requestId': 'test-request-id',
                'authorizer': {
                    'claims': {
                        'sub': user_id,
                    }
                },
                'identity': {
                    'sourceIp': '127.0.0.1',
                },
            },
        }
        event.update(kwargs)
        return event

    return _create_event


# =============================================================================
# ASSERTION HELPERS
# =============================================================================

def assert_no_real_aws_calls(caplog):
    """
    Assert that no real AWS API calls were made during test.

    This is a helper to verify tests are properly mocked.

    Usage:
        def test_something(caplog):
            # ... test code ...
            assert_no_real_aws_calls(caplog)
    """
    real_aws_indicators = [
        'botocore.httpsession',
        'amazonaws.com',
        'AccessDenied',
        'InvalidAccessKeyId',
    ]
    for record in caplog.records:
        message = record.getMessage()
        for indicator in real_aws_indicators:
            if indicator in message:
                raise AssertionError(
                    f'Real AWS call detected: {message}'
                )
