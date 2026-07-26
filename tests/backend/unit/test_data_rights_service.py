"""Tests for data subject export and erasure.

The failure that matters here is a *silent* one: an erasure that reports
success while leaving personal data behind. Most of these pin the specific
places that can happen — the Stripe mapping that lives outside the user's
partition, pagination, and partial batch failure.
"""

import json
from decimal import Decimal

import boto3
import pytest
from moto import mock_aws
from shared_services.data_rights_service import (
    BATCH_DELETE_SIZE,
    KNOWN_SK_PREFIXES,
    DataRightsService,
    to_json,
)

USER = 'user-abc'
OTHER_USER = 'user-xyz'


@pytest.fixture
def table(aws_credentials):
    with mock_aws():
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        t = dynamodb.create_table(
            TableName='data-rights-test',
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
                    'ProvisionedThroughput': {
                        'ReadCapacityUnits': 5,
                        'WriteCapacityUnits': 5,
                    },
                }
            ],
            ProvisionedThroughput={'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5},
        )
        yield t


def _seed(table, *, user=USER):
    """A representative spread of what an account accumulates."""
    items = [
        {'PK': f'USER#{user}', 'SK': '#SETTINGS', 'linkedinEmail': 'a@b.co'},
        {'PK': f'USER#{user}', 'SK': 'TIER#current', 'tier': 'pro'},
        {'PK': f'USER#{user}', 'SK': 'USAGE#monthly#2026-07', 'count': 12},
        # The inference data about a third party.
        {
            'PK': f'USER#{user}',
            'SK': 'PROFILE#abc123',
            'relationshipScore': 87,
            'replyProbability': Decimal('0.42'),
        },
        {'PK': f'USER#{user}', 'SK': 'NOTIFICATION#2026-07-01#n1'},
        {'PK': f'USER#{user}', 'SK': 'OPPORTUNITY#opp1'},
        {'PK': f'USER#{user}', 'SK': 'ADJ#a#b'},
    ]
    for item in items:
        table.put_item(Item=item)
    return items


def _seed_shared_profile(table):
    """Third-party profile data, shared across accounts."""
    table.put_item(Item={'PK': 'PROFILE#abc123', 'SK': '#METADATA', 'name': 'Someone Else'})


def _seed_stripe(table, user=USER, customer='cus_1'):
    table.put_item(
        Item={
            'PK': f'STRIPE#{customer}',
            'SK': '#MAPPING',
            'cognitoSub': user,
            'GSI1PK': f'USER#{user}',
            'GSI1SK': f'STRIPE#{customer}',
        }
    )


class TestExport:
    def test_returns_every_item_with_a_type_breakdown(self, table):
        _seed(table)

        result = DataRightsService(table).export_user_data(USER)

        assert result['itemCount'] == 7
        assert result['countsByType']['PROFILE'] == 1
        assert result['countsByType']['#SETTINGS'] == 1
        assert result['userId'] == USER

    def test_includes_the_inference_data(self, table):
        """Scores about third parties are personal data and must be disclosed."""
        _seed(table)

        result = DataRightsService(table).export_user_data(USER)

        edge = next(i for i in result['items'] if str(i['SK']).startswith('PROFILE#'))
        assert 'relationshipScore' in edge
        assert 'replyProbability' in edge

    def test_includes_the_stripe_mapping(self, table):
        """Erasure destroys it, so an export that omitted it discloses less."""
        _seed(table)
        _seed_stripe(table)

        result = DataRightsService(table).export_user_data(USER)

        assert any(str(i['PK']).startswith('STRIPE#') for i in result['items'])
        assert result['countsByType']['STRIPE'] == 1

    def test_explains_what_is_excluded(self, table):
        _seed(table)

        result = DataRightsService(table).export_user_data(USER)

        assert 'sharedProfileRecords' in result['notIncluded']

    def test_does_not_leak_another_users_data(self, table):
        _seed(table, user=USER)
        _seed(table, user=OTHER_USER)

        result = DataRightsService(table).export_user_data(USER)

        assert all(i['PK'] == f'USER#{USER}' for i in result['items'])

    def test_serialises_decimals_cleanly(self, table):
        _seed(table)

        payload = json.loads(to_json(DataRightsService(table).export_user_data(USER)))

        usage = next(i for i in payload['items'] if str(i['SK']).startswith('USAGE#'))
        # Counters must not export as "12.0".
        assert usage['count'] == 12
        assert isinstance(usage['count'], int)


class TestErasure:
    def test_removes_every_item_in_the_partition(self, table):
        _seed(table)

        report = DataRightsService(table).delete_user_data(USER)

        assert report['complete'] is True
        assert report['deleted'] == 7
        remaining = table.query(
            KeyConditionExpression='PK = :pk',
            ExpressionAttributeValues={':pk': f'USER#{USER}'},
        )['Items']
        assert remaining == []

    def test_removes_the_stripe_mapping_outside_the_partition(self, table):
        """Keyed by customer id, so a partition-only sweep would leave it."""
        _seed(table)
        _seed_stripe(table)

        DataRightsService(table).delete_user_data(USER)

        assert 'Item' not in table.get_item(Key={'PK': 'STRIPE#cus_1', 'SK': '#MAPPING'})

    def test_leaves_shared_third_party_profiles_alone(self, table):
        """Deleting them would destroy data belonging to other accounts."""
        _seed(table)
        _seed_shared_profile(table)

        DataRightsService(table).delete_user_data(USER)

        assert 'Item' in table.get_item(Key={'PK': 'PROFILE#abc123', 'SK': '#METADATA'})

    def test_leaves_other_accounts_untouched(self, table):
        _seed(table, user=USER)
        _seed(table, user=OTHER_USER)

        DataRightsService(table).delete_user_data(USER)

        survivors = table.query(
            KeyConditionExpression='PK = :pk',
            ExpressionAttributeValues={':pk': f'USER#{OTHER_USER}'},
        )['Items']
        assert len(survivors) == 7

    def test_is_idempotent(self, table):
        """Re-running must finish the job, not fail — the property that matters."""
        _seed(table)
        svc = DataRightsService(table)

        svc.delete_user_data(USER)
        second = svc.delete_user_data(USER)

        assert second['complete'] is True
        assert second['deleted'] == 0

    def test_handles_more_items_than_one_batch(self, table):
        for i in range(BATCH_DELETE_SIZE * 2 + 3):
            table.put_item(Item={'PK': f'USER#{USER}', 'SK': f'ACTIVITY#{i:04d}'})

        report = DataRightsService(table).delete_user_data(USER)

        assert report['deleted'] == BATCH_DELETE_SIZE * 2 + 3
        assert report['complete'] is True

    def test_reports_incomplete_rather_than_claiming_success(self, table):
        """A partial erasure must never report complete — that is the silent failure."""
        from unittest.mock import MagicMock

        from botocore.exceptions import ClientError

        _seed(table)
        broken = MagicMock()
        broken.query = table.query
        broken.batch_writer.side_effect = ClientError(
            {'Error': {'Code': 'ProvisionedThroughputExceededException'}},
            'BatchWriteItem',
        )

        report = DataRightsService(broken).delete_user_data(USER)

        assert report['complete'] is False
        assert report['failed'] > 0

    def test_a_missing_gsi_does_not_abort_the_erasure(self, table):
        """The rest of the data must still go, with the shortfall reported."""
        from unittest.mock import MagicMock

        from botocore.exceptions import ClientError

        _seed(table)
        svc = DataRightsService(table)
        svc._stripe_mapping_keys = MagicMock(
            side_effect=lambda _u: DataRightsService.__dict__['_stripe_mapping_keys'](svc, _u)
        )
        # Simulate the GSI being absent by making the indexed query fail.
        original_query = table.query

        def _query(**kwargs):
            if kwargs.get('IndexName') == 'GSI1':
                raise ClientError({'Error': {'Code': 'ValidationException'}}, 'Query')
            return original_query(**kwargs)

        svc.table = MagicMock()
        svc.table.query = _query
        svc.table.batch_writer = table.batch_writer

        report = svc.delete_user_data(USER)

        assert report['complete'] is True
        assert report['deleted'] == 7


class TestClassification:
    def test_every_known_prefix_is_recognised(self, table):
        for prefix in KNOWN_SK_PREFIXES:
            sk = prefix if prefix.startswith('#') else f'{prefix}x'
            table.put_item(Item={'PK': f'USER#{USER}', 'SK': sk})

        result = DataRightsService(table).export_user_data(USER)

        assert result['countsByType'].get('other', 0) == 0, (
            'a known prefix fell through to "other"; the export manifest would misreport it'
        )

    def test_an_unknown_entity_shows_up_rather_than_hiding(self, table):
        """A new SK type nobody classified must be visible, not silently normal."""
        table.put_item(Item={'PK': f'USER#{USER}', 'SK': 'BRAND_NEW_THING#1'})

        result = DataRightsService(table).export_user_data(USER)

        assert result['countsByType']['other'] == 1


class TestHandlerEndpoints:
    """The guard rails around an irreversible operation."""

    @pytest.fixture
    def handler(self, table, monkeypatch):
        from conftest import load_lambda_module

        monkeypatch.setenv('DYNAMODB_TABLE_NAME', table.name)
        module = load_lambda_module('dynamodb-api')
        module.table = table
        module._data_rights_service = None
        return module

    def _event(self, operation, **body):
        return {
            'httpMethod': 'POST',
            'rawPath': '/dynamodb',
            'requestContext': {
                'http': {'method': 'POST'},
                'authorizer': {'jwt': {'claims': {'sub': USER}}},
            },
            'body': json.dumps({'operation': operation, **body}),
        }

    def test_deletion_refuses_without_explicit_confirmation(self, handler, table):
        _seed(table)

        resp = handler.lambda_handler(self._event('delete_my_account'), None)

        assert resp['statusCode'] == 400
        assert json.loads(resp['body'])['code'] == 'CONFIRMATION_REQUIRED'
        # Nothing may be removed by an unconfirmed request.
        remaining = table.query(
            KeyConditionExpression='PK = :pk',
            ExpressionAttributeValues={':pk': f'USER#{USER}'},
        )['Items']
        assert len(remaining) == 7

    def test_a_wrong_confirmation_string_is_refused(self, handler, table):
        _seed(table)

        resp = handler.lambda_handler(self._event('delete_my_account', confirm='yes'), None)

        assert resp['statusCode'] == 400

    def test_confirmed_deletion_erases_the_account(self, handler, table):
        _seed(table)

        resp = handler.lambda_handler(self._event('delete_my_account', confirm='DELETE MY ACCOUNT'), None)

        assert resp['statusCode'] == 200
        assert json.loads(resp['body'])['complete'] is True

    def test_export_returns_the_account_data(self, handler, table):
        _seed(table)

        resp = handler.lambda_handler(self._event('export_my_data'), None)

        assert resp['statusCode'] == 200
        assert json.loads(resp['body'])['itemCount'] == 7

    def test_export_preserves_numbers_as_numbers(self, handler, table):
        """api_response serialises with default=str; counters must not become "12"."""
        _seed(table)

        resp = handler.lambda_handler(self._event('export_my_data'), None)

        body = json.loads(resp['body'])
        usage = next(i for i in body['items'] if str(i['SK']).startswith('USAGE#'))
        assert usage['count'] == 12
        assert not isinstance(usage['count'], str)

    def test_the_deletion_audit_record_outlives_the_erasure(self, handler, table, caplog):
        """An ACTIVITY# row would be swept up by the erasure it documents."""
        import logging

        _seed(table)

        with caplog.at_level(logging.INFO):
            handler.lambda_handler(self._event('delete_my_account', confirm='DELETE MY ACCOUNT'), None)

        assert any(r.getMessage() == 'account_deletion_requested' for r in caplog.records), (
            'no durable trace that the account was asked to be erased'
        )
        # And nothing was left behind in the partition to hold it.
        left = table.query(
            KeyConditionExpression='PK = :pk',
            ExpressionAttributeValues={':pk': f'USER#{USER}'},
        )['Items']
        assert left == []

    def test_a_partial_erasure_reports_failure_not_success(self, handler, table, monkeypatch):
        """Reporting 200 would tell the subject their data is gone when it is not."""
        _seed(table)

        class _Partial:
            def delete_user_data(self, _user):
                return {'userId': _user, 'deleted': 3, 'failed': 4, 'complete': False}

        monkeypatch.setattr(handler, '_get_data_rights_service', lambda: _Partial())

        resp = handler.lambda_handler(self._event('delete_my_account', confirm='DELETE MY ACCOUNT'), None)

        assert resp['statusCode'] == 500
        assert json.loads(resp['body'])['complete'] is False


class TestConcurrentWritesDoNotSurvive:
    """Enumerate-then-delete has a race the report must not paper over."""

    def test_an_item_written_mid_erasure_is_still_removed(self, table):
        _seed(table)
        svc = DataRightsService(table)
        original = svc._delete_keys
        injected = {'done': False}

        def _delete_then_write(user_sub, keys):
            result = original(user_sub, keys)
            # Simulate a concurrent quota counter landing after enumeration.
            if not injected['done']:
                injected['done'] = True
                table.put_item(Item={'PK': f'USER#{USER}', 'SK': 'USAGE#daily#2026-07-26', 'count': 1})
            return result

        svc._delete_keys = _delete_then_write
        report = svc.delete_user_data(USER)

        assert report['complete'] is True
        assert report['remaining'] == 0
        assert report['passes'] >= 2, 'a second sweep is what catches the late write'
        left = table.query(
            KeyConditionExpression='PK = :pk',
            ExpressionAttributeValues={':pk': f'USER#{USER}'},
        )['Items']
        assert left == []

    def test_reports_incomplete_when_data_survives(self, table):
        """Never claim complete while the partition still holds records."""
        from unittest.mock import MagicMock

        _seed(table)
        svc = DataRightsService(table)
        # A delete that silently does nothing: the report must not say complete.
        svc._delete_keys = MagicMock(return_value=(7, 0))

        report = svc.delete_user_data(USER)

        assert report['complete'] is False
        assert report['remaining'] == 7


class TestUserFacingTerminology:
    """The export text is read by data subjects, so its wording is substantive.

    "Scraped" was corrected in the documents and the docstrings but survived in
    the string actually returned to users — three separate passes missed it.
    This pins it rather than relying on remembering.
    """

    def test_the_export_note_does_not_call_records_scraped(self, table):
        _seed(table)

        note = DataRightsService(table).export_user_data(USER)['notIncluded']

        blob = json.dumps(note).lower()
        assert 'scrap' not in blob, (
            'the export tells data subjects their connections were "scraped"; '
            'the legal documents deliberately describe these as imported records'
        )

    def test_the_note_still_explains_the_exclusion(self, table):
        """Rewording must not quietly drop the substance."""
        _seed(table)

        note = DataRightsService(table).export_user_data(USER)['notIncluded']['sharedProfileRecords']

        assert 'shared' in note.lower()
        assert 'other users' in note.lower()
