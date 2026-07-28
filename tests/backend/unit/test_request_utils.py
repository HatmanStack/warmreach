"""Tests for shared_services.request_utils."""

import json
import os
from datetime import datetime
from unittest.mock import patch

import pytest


@pytest.fixture(autouse=True)
def set_allowed_origins(monkeypatch):
    monkeypatch.setenv('ALLOWED_ORIGINS', 'http://localhost:5173,https://app.example.com')


def _load_request_utils():
    """Import the module fresh to pick up env var changes."""
    import importlib
    import shared_services.request_utils as mod
    importlib.reload(mod)
    return mod


class TestExtractUserId:
    def test_http_api_v2_jwt(self):
        mod = _load_request_utils()
        event = {
            'requestContext': {
                'authorizer': {
                    'jwt': {
                        'claims': {'sub': 'user-abc-123'}
                    }
                }
            }
        }
        assert mod.extract_user_id(event) == 'user-abc-123'

    def test_rest_api_claims(self):
        mod = _load_request_utils()
        event = {
            'requestContext': {
                'authorizer': {
                    'claims': {'sub': 'user-rest-456'}
                }
            }
        }
        assert mod.extract_user_id(event) == 'user-rest-456'

    def test_missing_auth_returns_none(self):
        mod = _load_request_utils()
        event = {'requestContext': {}}
        assert mod.extract_user_id(event) is None

    def test_empty_event_returns_none(self):
        mod = _load_request_utils()
        assert mod.extract_user_id({}) is None


class TestCorsHeaders:
    def test_matching_origin(self):
        mod = _load_request_utils()
        event = {'headers': {'origin': 'http://localhost:5173'}}
        headers = mod.cors_headers(event)
        assert headers['Access-Control-Allow-Origin'] == 'http://localhost:5173'
        assert headers['Vary'] == 'Origin'
        assert headers['Content-Type'] == 'application/json'

    def test_non_matching_origin_omits_cors_header(self):
        mod = _load_request_utils()
        event = {'headers': {'origin': 'https://evil.com'}}
        headers = mod.cors_headers(event)
        assert 'Access-Control-Allow-Origin' not in headers

    def test_no_origin_header_omits_cors_origin(self):
        mod = _load_request_utils()
        event = {'headers': {}}
        headers = mod.cors_headers(event)
        assert 'Access-Control-Allow-Origin' not in headers

    def test_no_configured_origins_omits_cors_header(self):
        mod = _load_request_utils()
        event = {'headers': {'origin': 'http://localhost:5173'}}
        headers = mod.cors_headers(event, allowed_origins=[])
        assert 'Access-Control-Allow-Origin' not in headers

    def test_custom_allowed_methods(self):
        mod = _load_request_utils()
        event = {'headers': {'origin': 'http://localhost:5173'}}
        headers = mod.cors_headers(event, allowed_methods='GET,POST,PUT,DELETE,OPTIONS')
        assert headers['Access-Control-Allow-Methods'] == 'GET,POST,PUT,DELETE,OPTIONS'

    def test_case_insensitive_origin_header(self):
        mod = _load_request_utils()
        event = {'headers': {'Origin': 'https://app.example.com'}}
        headers = mod.cors_headers(event)
        assert headers['Access-Control-Allow-Origin'] == 'https://app.example.com'


class TestApiResponse:
    def test_basic_response(self):
        mod = _load_request_utils()
        event = {'headers': {'origin': 'http://localhost:5173'}}
        resp = mod.api_response(200, {'message': 'ok'}, event)
        assert resp['statusCode'] == 200
        assert resp['headers']['Access-Control-Allow-Origin'] == 'http://localhost:5173'
        body = json.loads(resp['body'])
        assert body['message'] == 'ok'

    def test_no_event_omits_cors_origin(self):
        mod = _load_request_utils()
        resp = mod.api_response(500, {'error': 'fail'})
        assert resp['statusCode'] == 500
        assert 'Access-Control-Allow-Origin' not in resp['headers']

    def test_datetime_serialization(self):
        mod = _load_request_utils()
        dt = datetime(2026, 1, 1, 12, 0, 0)
        resp = mod.api_response(200, {'timestamp': dt})
        body = json.loads(resp['body'])
        assert body['timestamp'] == '2026-01-01 12:00:00'

    def test_string_body(self):
        mod = _load_request_utils()
        resp = mod.api_response(204, '')
        assert resp['body'] == '""'

    def test_custom_allowed_methods(self):
        mod = _load_request_utils()
        event = {'headers': {'origin': 'http://localhost:5173'}}
        resp = mod.api_response(200, {}, event, allowed_methods='GET,OPTIONS')
        assert resp['headers']['Access-Control-Allow-Methods'] == 'GET,OPTIONS'
