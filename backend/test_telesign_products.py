"""Provider-contract tests for Telesign Intelligence and Phone ID/Contact."""

import asyncio
import json
import urllib.parse

import telesign_service


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


def credentials(monkeypatch):
    monkeypatch.setenv('TELESIGN_CUSTOMER_ID', 'customer-id')
    monkeypatch.setenv('TELESIGN_API_KEY', 'provider-secret')


def test_intelligence_uses_lifecycle_context_and_returns_only_safe_signals(monkeypatch):
    credentials(monkeypatch)
    captured = {}

    def fake_urlopen(request, timeout):
        captured['request'] = request
        return FakeResponse({
            'reference_id': 'intelligence-reference',
            'status': {'code': 300},
            'risk': {'score': 472, 'level': 'medium', 'recommendation': 'flag'},
            'risk_insights': {'status': 800, 'category': [10002], 'unsafe': ['text']},
            'phone_type': {'code': '1', 'description': 'FIXED_LINE'},
            'carrier': {'name': 'Example Carrier'},
            'location': {'country': {'iso2': 'IN', 'iso3': 'IND'}},
            'numbering': {'original': {'complete_phone_number': '919876543210'}},
        })

    monkeypatch.setattr(telesign_service.urllib.request, 'urlopen', fake_urlopen)
    result = asyncio.run(telesign_service.evaluate_phone(
        '+91 98765 43210',
        'sign-in',
        account_id='player-1',
        email_address='player@example.com',
    ))

    body = urllib.parse.parse_qs(captured['request'].data.decode('utf-8'))
    assert body == {
        'phone_number': ['919876543210'],
        'account_lifecycle_event': ['sign-in'],
        'account_id': ['player-1'],
        'email_address': ['player@example.com'],
    }
    assert result['risk'] == {
        'score': 472, 'level': 'medium', 'recommendation': 'flag',
    }
    assert result['risk_insights'] == {'status': 800, 'category': [10002], 'unsafe': []}
    assert 'numbering' not in result


def test_phone_id_contact_discards_returned_contact_pii(monkeypatch):
    credentials(monkeypatch)
    captured = {}

    def fake_urlopen(request, timeout):
        captured['request'] = request
        return FakeResponse({
            'reference_id': 'phone-id-reference',
            'status': {'code': 300},
            'phone_type': {'code': '1', 'description': 'MOBILE'},
            'carrier': {'name': 'Example Carrier'},
            'location': {'country': {'iso2': 'IN', 'iso3': 'IND'}},
            'contact': {
                'status': {'code': 2800},
                'first_name': 'Private',
                'last_name': 'Person',
                'address1': 'Secret address',
                'email_address': 'private@example.com',
            },
        })

    monkeypatch.setattr(telesign_service.urllib.request, 'urlopen', fake_urlopen)
    result = asyncio.run(telesign_service.phone_id_contact(
        '+919876543210', include_contact=True,
    ))

    assert json.loads(captured['request'].data) == {'addons': {'contact': {}}}
    assert result['contact_addon'] == {
        'requested': True, 'status_code': 2800, 'available': True,
    }
    serialized = json.dumps(result)
    assert 'Private' not in serialized
    assert 'Secret address' not in serialized
    assert 'private@example.com' not in serialized


def test_product_status_separates_plan_access_from_paid_call_controls(monkeypatch):
    credentials(monkeypatch)
    monkeypatch.setenv('OTP_SMS_ADAPTER', 'telesign')
    monkeypatch.setenv('TELESIGN_INTELLIGENCE_MODE', 'observe')
    monkeypatch.setenv('TELESIGN_PHONE_ID_MODE', 'disabled')
    monkeypatch.setenv('TELESIGN_CONTACT_ADDON_ENABLED', 'true')
    monkeypatch.setenv('TELESIGN_VERIFY_PLUS_ENABLED', 'true')
    monkeypatch.setenv('TELESIGN_ENGAGEMENT_SMS_ENABLED', 'false')

    status = telesign_service.product_status()

    assert status['credentials_ready'] is True
    assert status['products']['intelligence']['enabled'] is True
    assert status['products']['intelligence']['mode'] == 'observe'
    assert status['products']['phone_id']['enabled'] is False
    assert status['products']['contact_addon']['enabled'] is False
    assert status['products']['sms_verify']['enabled'] is True
    assert status['products']['verify_plus']['enabled'] is True
    assert status['products']['sms']['enabled'] is False
