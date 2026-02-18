"""Tests for QuotaService (ported from warmreach-cp, USER# key pattern)."""

import os

import pytest
from moto import mock_aws

os.environ['DYNAMODB_TABLE_NAME'] = 'test-table'


@pytest.fixture
def quota_table(aws_credentials):
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


def _seed_tier(table, user_sub='user-1', tier='free', daily=50, monthly=500):
    table.put_item(Item={
        'PK': f'USER#{user_sub}',
        'SK': 'TIER#current',
        'tier': tier,
        'quotas': {
            'daily_linkedin_interactions': daily,
            'hourly_linkedin_interactions': 15,
            'monthly_linkedin_interactions': monthly,
        },
    })


class TestGetRateLimits:
    def test_returns_limits_and_zero_usage(self, quota_table):
        from shared_services.quota_service import QuotaService
        svc = QuotaService(quota_table)
        _seed_tier(quota_table)

        result = svc.get_rate_limits('user-1')
        li = result['linkedin_interactions']
        assert li['daily_limit'] == 50
        assert li['hourly_limit'] == 15
        assert li['current_daily'] == 0
        assert li['current_hourly'] == 0


class TestGetQuotaStatus:
    def test_allowed_when_under_limit(self, quota_table):
        from shared_services.quota_service import QuotaService
        svc = QuotaService(quota_table)
        _seed_tier(quota_table)

        result = svc.get_quota_status('user-1', 'linkedin_interaction')
        assert result['allowed'] is True
        assert result['remaining'] == 50

    def test_raises_when_daily_exceeded(self, quota_table):
        from shared_services.quota_service import QuotaService
        svc = QuotaService(quota_table)
        _seed_tier(quota_table, daily=5)

        from datetime import UTC, datetime
        daily_key = datetime.now(UTC).strftime('%Y-%m-%d')
        quota_table.put_item(Item={
            'PK': 'USER#user-1',
            'SK': f'USAGE#daily#{daily_key}',
            'count': 5,
        })

        with pytest.raises(Exception, match='Daily quota exceeded'):
            svc.get_quota_status('user-1', 'linkedin_interaction')


class TestReportUsage:
    def test_report_usage_increments_counters(self, quota_table):
        from shared_services.quota_service import QuotaService
        svc = QuotaService(quota_table)
        _seed_tier(quota_table)

        svc.report_usage('user-1', 'linkedin_interaction', count=1)

        from datetime import UTC, datetime
        daily_key = datetime.now(UTC).strftime('%Y-%m-%d')
        item = quota_table.get_item(
            Key={'PK': 'USER#user-1', 'SK': f'USAGE#daily#{daily_key}'}
        ).get('Item')
        assert item is not None
        assert int(item['count']) == 1

    def test_report_usage_enforces_daily_limit(self, quota_table):
        from shared_services.quota_service import QuotaService
        svc = QuotaService(quota_table)
        _seed_tier(quota_table, daily=2)

        svc.report_usage('user-1', 'linkedin_interaction', count=1)
        svc.report_usage('user-1', 'linkedin_interaction', count=1)

        with pytest.raises(Exception, match='Daily quota exceeded'):
            svc.report_usage('user-1', 'linkedin_interaction', count=1)

    def test_report_usage_invalid_count(self, quota_table):
        from shared_services.quota_service import QuotaService
        svc = QuotaService(quota_table)
        _seed_tier(quota_table)

        with pytest.raises(Exception, match='Invalid count'):
            svc.report_usage('user-1', 'linkedin_interaction', count=0)

    def test_report_usage_sets_ttl(self, quota_table):
        from shared_services.quota_service import QuotaService
        svc = QuotaService(quota_table)
        _seed_tier(quota_table)

        svc.report_usage('user-1', 'linkedin_interaction', count=1)

        from datetime import UTC, datetime
        daily_key = datetime.now(UTC).strftime('%Y-%m-%d')
        item = quota_table.get_item(
            Key={'PK': 'USER#user-1', 'SK': f'USAGE#daily#{daily_key}'}
        ).get('Item')
        assert 'ttl' in item
