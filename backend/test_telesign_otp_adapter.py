"""Focused tests for the Telesign SMS Verify delivery adapter."""

import asyncio
import base64
import json
import os
import sys
import types
import urllib.parse


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.modules.setdefault('db', types.SimpleNamespace(db=None))

import otp_service


class FakeResponse:
    def __init__(self, payload, status=200):
        self.payload = json.dumps(payload).encode('utf-8')
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self, amount):
        return self.payload[:amount]


def test_telesign_adapter_sends_normalized_code_without_leaking_credentials(monkeypatch):
    monkeypatch.setenv('TELESIGN_CUSTOMER_ID', 'customer-id')
    monkeypatch.setenv('TELESIGN_API_KEY', 'provider-secret')
    captured = {}

    def fake_urlopen(request, timeout):
        captured['request'] = request
        captured['timeout'] = timeout
        return FakeResponse({
            'reference_id': 'safe-reference-id',
            'errors': [],
            'status': {'code': 290, 'description': 'Message in progress'},
        })

    monkeypatch.setattr(otp_service.urllib.request, 'urlopen', fake_urlopen)
    result = asyncio.run(otp_service.TelesignSmsAdapter().send(
        otp_service.Identity('SMS', '+91 98765 43210'),
        '123456',
        otp_service.VERIFY_CONTACT,
    ))

    assert result == {
        'sent': True,
        'provider': 'telesign',
        'reference_id': 'safe-reference-id',
    }
    assert captured['timeout'] == 10
    request = captured['request']
    assert request.full_url == otp_service.TelesignSmsAdapter.VERIFY_SMS_URL
    assert request.get_method() == 'POST'
    body = urllib.parse.parse_qs(request.data.decode('utf-8'))
    assert body['phone_number'] == ['919876543210']
    assert body['verify_code'] == ['123456']
    assert body['template'] == [
        'Your Chakri.Casino verification code is $$CODE$$. It expires in 15 minutes.'
    ]
    expected_auth = base64.b64encode(
        b'customer-id:provider-secret'
    ).decode('ascii')
    assert request.get_header('Authorization') == f'Basic {expected_auth}'


def test_telesign_adapter_rejects_provider_error_status(monkeypatch):
    monkeypatch.setenv('TELESIGN_CUSTOMER_ID', 'customer-id')
    monkeypatch.setenv('TELESIGN_API_KEY', 'provider-secret')

    monkeypatch.setattr(
        otp_service.urllib.request,
        'urlopen',
        lambda request, timeout: FakeResponse({
            'reference_id': '',
            'errors': [{'code': -10033}],
            'status': {'code': 500, 'description': 'Transaction not attempted'},
        }, status=401),
    )
    result = asyncio.run(otp_service.TelesignSmsAdapter().send(
        otp_service.Identity('SMS', '+919876543210'),
        '123456',
        otp_service.VERIFY_CONTACT,
    ))

    assert result == {
        'sent': False,
        'provider': 'telesign',
        'error': 'provider_rejected',
    }


def test_telesign_readiness_requires_both_credentials(monkeypatch):
    monkeypatch.setenv('OTP_SMS_ADAPTER', 'telesign')
    monkeypatch.delenv('TELESIGN_CUSTOMER_ID', raising=False)
    monkeypatch.delenv('TELESIGN_API_KEY', raising=False)
    assert otp_service.delivery_adapter_ready('SMS') is False

    monkeypatch.setenv('TELESIGN_CUSTOMER_ID', 'customer-id')
    assert otp_service.delivery_adapter_ready('SMS') is False

    monkeypatch.setenv('TELESIGN_API_KEY', 'provider-secret')
    assert otp_service.delivery_adapter_ready('SMS') is True
    assert isinstance(otp_service.delivery_adapter('SMS'), otp_service.TelesignSmsAdapter)
