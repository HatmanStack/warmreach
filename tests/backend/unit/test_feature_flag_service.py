"""Tests for FeatureFlagService (ported from warmreach-cp, USER# key pattern)."""

import os

import pytest
from moto import mock_aws

os.environ['DYNAMODB_TABLE_NAME'] = 'test-table'


@pytest.fixture
def ff_table(aws_credentials):
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


class TestGetFeatureFlags:
    def test_returns_tier_and_features(self, ff_table):
        from shared_services.feature_flag_service import FeatureFlagService
        svc = FeatureFlagService(ff_table)

        ff_table.put_item(Item={
            'PK': 'USER#user-1',
            'SK': 'TIER#current',
            'tier': 'paid',
            'features': {'deep_research': True, 'ai_messaging': True},
            'quotas': {'daily_linkedin_interactions': 200},
        })

        result = svc.get_feature_flags('user-1')
        assert result['tier'] == 'paid'
        assert result['features']['deep_research'] is True
        assert result['quotas']['daily_linkedin_interactions'] == 200

    def test_includes_global_rate_limits(self, ff_table):
        from shared_services.feature_flag_service import FeatureFlagService
        svc = FeatureFlagService(ff_table)

        ff_table.put_item(Item={
            'PK': 'USER#user-1',
            'SK': 'TIER#current',
            'tier': 'free',
            'features': {},
            'quotas': {},
        })
        ff_table.put_item(Item={
            'PK': 'GLOBAL#config',
            'SK': 'RATELIMIT#free',
            'rateLimits': {'requests_per_minute': 30},
        })

        result = svc.get_feature_flags('user-1')
        assert result['rateLimits']['requests_per_minute'] == 30

    def test_user_not_found_raises(self, ff_table):
        from shared_services.feature_flag_service import FeatureFlagService
        svc = FeatureFlagService(ff_table)

        with pytest.raises(Exception, match='User not found'):
            svc.get_feature_flags('nonexistent-user')

    def test_missing_global_config_returns_empty_rate_limits(self, ff_table):
        from shared_services.feature_flag_service import FeatureFlagService
        svc = FeatureFlagService(ff_table)

        ff_table.put_item(Item={
            'PK': 'USER#user-1',
            'SK': 'TIER#current',
            'tier': 'free',
            'features': {},
            'quotas': {},
        })

        result = svc.get_feature_flags('user-1')
        assert result['rateLimits'] == {}
