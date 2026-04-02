"""MiniStack fixtures for integration tests."""

import os

import boto3
import pytest


@pytest.fixture
def ministack_dynamodb_table():
    """Create a DynamoDB table on MiniStack matching SAM template schema.

    Connects to MINISTACK_ENDPOINT (default http://localhost:4566).
    Creates the table, yields it, then deletes on teardown.
    """
    endpoint = os.environ.get('MINISTACK_ENDPOINT', 'http://localhost:4566')
    region = os.environ.get('AWS_DEFAULT_REGION', 'us-east-1')

    dynamodb = boto3.resource(
        'dynamodb',
        endpoint_url=endpoint,
        region_name=region,
        aws_access_key_id='test',
        aws_secret_access_key='test',
    )

    table_name = f'integration-test-{os.getpid()}'

    table = dynamodb.create_table(
        TableName=table_name,
        KeySchema=[
            {'AttributeName': 'PK', 'KeyType': 'HASH'},
            {'AttributeName': 'SK', 'KeyType': 'RANGE'},
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
            }
        ],
        BillingMode='PAY_PER_REQUEST',
    )

    table.meta.client.get_waiter('table_exists').wait(TableName=table_name)

    yield table

    table.delete()
