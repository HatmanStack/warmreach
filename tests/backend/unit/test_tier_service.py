"""Tests for tier_service auto-provisioning."""

import os

import pytest
from moto import mock_aws

os.environ['DYNAMODB_TABLE_NAME'] = 'test-table'


@pytest.fixture
def tier_table(aws_credentials):
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
                    'ProvisionedThroughput': {'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5},
                }
            ],
            ProvisionedThroughput={'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5},
        )
        yield table


class TestEnsureTierExists:
    def test_creates_free_tier_for_new_user(self, tier_table):
        from shared_services.tier_service import ensure_tier_exists
        result = ensure_tier_exists(tier_table, 'new-user')

        assert result['tier'] == 'free'
        assert result['quotas']['daily_linkedin_interactions'] == 50

        # Verify persisted
        item = tier_table.get_item(
            Key={'PK': 'USER#new-user', 'SK': 'TIER#current'}
        ).get('Item')
        assert item is not None
        assert item['tier'] == 'free'

    def test_returns_existing_tier(self, tier_table):
        from shared_services.tier_service import ensure_tier_exists

        tier_table.put_item(Item={
            'PK': 'USER#existing-user',
            'SK': 'TIER#current',
            'tier': 'paid',
            'quotas': {'daily_linkedin_interactions': 200},
            'features': {'deep_research': True},
        })

        result = ensure_tier_exists(tier_table, 'existing-user')
        assert result['tier'] == 'paid'
        assert result['quotas']['daily_linkedin_interactions'] == 200

    def test_idempotent_creation(self, tier_table):
        from shared_services.tier_service import ensure_tier_exists

        result1 = ensure_tier_exists(tier_table, 'user-1')
        result2 = ensure_tier_exists(tier_table, 'user-1')

        assert result1['tier'] == result2['tier'] == 'free'
