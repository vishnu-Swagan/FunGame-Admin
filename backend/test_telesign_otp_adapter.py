"""Focused tests for the Telesign SMS Verify delivery adapter."""

import asyncio
import base64
from datetime import datetime, timezone
import io
import json
import os
import sys
import types
import urllib.error
import urllib.parse

from mongomock_motor import AsyncMongoMockClient
import pytest


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.modules.setdefault('db', types.SimpleNamespace(db=None))

import otp_service
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
        'status_code': 290,
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
    assert 'dlt_template_id' not in body
    assert 'dlt_entity_id' not in body
    expected_auth = base64.b64encode(
        b'customer-id:provider-secret'
    ).decode('ascii')
    assert request.get_header('Authorization') == f'Basic {expected_auth}'


def test_real_http_error_retains_only_bounded_safe_metadata(monkeypatch):
    monkeypatch.setenv('TELESIGN_CUSTOMER_ID', 'customer-id-secret-sentinel')
    monkeypatch.setenv('TELESIGN_API_KEY', 'provider-key-secret-sentinel')
    raw_body = json.dumps({
        'reference_id': 'reference-secret-sentinel',
        'recipient': '+919876543210',
        'security_factor': '123456',
        'status': {
            'code': 500,
            'description': 'OTP 123456 failed for +919876543210',
        },
        'errors': [
            {'code': -10033, 'description': 'provider-key-secret-sentinel'},
            {'code': '-10034', 'description': 'not a numeric code'},
            {'code': True, 'description': 'booleans are not provider codes'},
        ],
    }).encode('utf-8')

    def fake_urlopen(request, timeout):
        raise urllib.error.HTTPError(
            request.full_url,
            429,
            'recipient +919876543210 code 123456',
            {'Retry-After': ' 060 '},
            io.BytesIO(raw_body),
        )

    monkeypatch.setattr(telesign_service.urllib.request, 'urlopen', fake_urlopen)
    with pytest.raises(telesign_service.TelesignServiceError) as raised:
        asyncio.run(telesign_service.send_verify_sms(
            '+919876543210', '123456', otp_service.VERIFY_CONTACT,
        ))

    error = raised.value
    assert error.reason == 'HTTPError'
    assert error.http_status == 429
    assert error.provider_status_code == 500
    assert error.provider_error_codes == (-10033,)
    assert error.retry_after == '60'
    assert error.metadata == {
        'http_status': 429,
        'provider_status_code': 500,
        'provider_error_codes': (-10033,),
        'retry_after': '60',
    }
    assert error.__cause__ is None
    assert error.__context__ is None
    safe_diagnostics = repr(error.__dict__)
    for secret in (
        'customer-id-secret-sentinel', 'provider-key-secret-sentinel',
        '+919876543210', '123456', 'reference-secret-sentinel',
    ):
        assert secret not in safe_diagnostics


def test_http_error_body_read_is_bounded(monkeypatch):
    monkeypatch.setenv('TELESIGN_CUSTOMER_ID', 'customer-id')
    monkeypatch.setenv('TELESIGN_API_KEY', 'provider-secret')

    class RecordingBody(io.BytesIO):
        def __init__(self, value):
            super().__init__(value)
            self.read_amounts = []

        def read(self, amount=-1):
            self.read_amounts.append(amount)
            return super().read(amount)

    body = RecordingBody(b'{' + b'x' * (telesign_service.MAX_RESPONSE_BYTES + 1))

    def fake_urlopen(request, timeout):
        raise urllib.error.HTTPError(
            request.full_url,
            503,
            'Service unavailable',
            {'Retry-After': 'not-a-safe-value\r\nX-Injected: secret'},
            body,
        )

    monkeypatch.setattr(telesign_service.urllib.request, 'urlopen', fake_urlopen)
    with pytest.raises(telesign_service.TelesignServiceError) as raised:
        asyncio.run(telesign_service.send_verify_sms(
            '+919876543210', '123456', otp_service.VERIFY_CONTACT,
        ))

    assert body.read_amounts == [telesign_service.MAX_RESPONSE_BYTES + 1]
    assert raised.value.metadata == {'http_status': 503}


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
        'error': 'trial_unverified_destination',
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


def test_telesign_verify_email_adapter_and_completion(monkeypatch):
    monkeypatch.setenv('TELESIGN_CUSTOMER_ID', 'customer-id')
    monkeypatch.setenv('TELESIGN_API_KEY', 'provider-secret')
    monkeypatch.setenv('OTP_EMAIL_ADAPTER', 'telesign_verify')
    monkeypatch.setenv('TELESIGN_VERIFY_TEMPLATE', 'chakri_verification')
    captured = []

    def fake_urlopen(request, timeout):
        captured.append(request)
        if request.get_method() == 'PATCH':
            return FakeResponse({'status': {'code': 3900, 'description': 'Verified'}})
        return FakeResponse({
            'reference_id': '0123456789ABCDEF0123456789ABCDEF',
            'state': 'ONGOING',
            'errors': [],
            'status': {'code': 3901, 'description': 'Request in progress'},
        })

    monkeypatch.setattr(otp_service.urllib.request, 'urlopen', fake_urlopen)
    assert otp_service.delivery_adapter_ready('EMAIL') is True
    result = asyncio.run(otp_service.delivery_adapter('EMAIL').send(
        otp_service.Identity('EMAIL', 'player@example.com'),
        '654321',
        otp_service.VERIFY_CONTACT,
    ))
    assert result == {
        'sent': True,
        'provider': 'telesign_verify',
        'reference_id': '0123456789ABCDEF0123456789ABCDEF',
        'status_code': 3901,
    }
    request = captured[0]
    assert request.full_url == telesign_service.VERIFY_API_URL
    assert request.get_method() == 'POST'
    assert json.loads(request.data) == {
        'recipient': {'email': 'player@example.com'},
        'security_factor': '654321',
        'verification_policy': [{'method': 'email'}],
        'message_template': {'name': 'chakri_verification'},
    }

    completion = asyncio.run(telesign_service.finalize_verification(
        result['reference_id'], '654321',
    ))
    assert completion == {'status_code': 3900}
    completion_request = captured[1]
    assert completion_request.get_method() == 'PATCH'
    assert completion_request.full_url.endswith(
        '/0123456789ABCDEF0123456789ABCDEF/state'
    )
    assert json.loads(completion_request.data) == {
        'action': 'finalize', 'security_factor': '654321',
    }


def test_legacy_sms_completion_uses_provider_reference(monkeypatch):
    monkeypatch.setenv('TELESIGN_CUSTOMER_ID', 'customer-id')
    monkeypatch.setenv('TELESIGN_API_KEY', 'provider-secret')
    captured = []

    def fake_urlopen(request, timeout):
        captured.append(request)
        return FakeResponse({
            'reference_id': '0123456789ABCDEF0123456789ABCDEF',
            'errors': [],
            'status': {'code': 1900, 'description': 'Completion recorded'},
        })

    monkeypatch.setattr(otp_service.urllib.request, 'urlopen', fake_urlopen)
    result = asyncio.run(telesign_service.report_sms_completion(
        '0123456789ABCDEF0123456789ABCDEF',
    ))
    assert result == {'status_code': 1900}
    request = captured[0]
    assert request.get_method() == 'PUT'
    assert request.data == b''
    assert request.full_url.endswith(
        '/v1/verify/completion/0123456789ABCDEF0123456789ABCDEF'
    )


@pytest.mark.parametrize('provider_status', [200, 203, 290])
def test_legacy_sms_acceptance_is_not_assumed_delivered(
    monkeypatch, provider_status,
):
    monkeypatch.setenv(
        'OTP_PEPPER', 'test-only-otp-pepper-with-at-least-32-characters',
    )
    recorded_at = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(otp_service, '_now', lambda: recorded_at)

    class StubTelesignAdapter:
        async def send(self, identity, code, purpose):
            return {
                'sent': True,
                'provider': 'telesign',
                'reference_id': f'reference-{provider_status}',
                'status_code': provider_status,
            }

    monkeypatch.setattr(
        otp_service, 'delivery_adapter', lambda channel: StubTelesignAdapter(),
    )
    client = AsyncMongoMockClient()
    database = client[f'telesign_acceptance_{provider_status}']
    identity = otp_service.Identity('SMS', f'+91987654{provider_status:03d}')

    response = asyncio.run(otp_service.issue_challenge(
        {'id': f'user-{provider_status}'},
        identity,
        otp_service.VERIFY_CONTACT,
        database=database,
        now=recorded_at,
        consume_limit=False,
    ))
    stored = asyncio.run(database.otp_challenges.find_one({
        'id': response['challenge_id'],
    }))

    assert stored['delivery_provider'] == 'telesign'
    assert otp_service._as_utc(stored['accepted_at']) == recorded_at
    assert stored['provider_initial_status_code'] == provider_status
    assert stored['delivery_reference_id'] == f'reference-{provider_status}'
    if provider_status == 200:
        assert otp_service._as_utc(stored['delivered_at']) == recorded_at
    else:
        assert 'delivered_at' not in stored
    assert not {
        'accepted_at', 'delivered_at', 'provider_initial_status_code',
        'delivery_reference_id',
    }.intersection(response)


def test_verify_api_unavailable_detects_401_3906():
    error = telesign_service.TelesignServiceError(
        'HTTPError', http_status=401, provider_status_code=3906,
    )
    assert telesign_service.verify_api_unavailable(error) is True
    assert telesign_service.verify_api_unavailable(
        telesign_service.TelesignServiceError(
            'HTTPError', http_status=401, provider_status_code=3400,
        )
    ) is False
    assert telesign_service.verify_api_unavailable(
        telesign_service.TelesignServiceError('HTTPError', http_status=401)
    ) is False


def test_verify_api_3906_falls_back_to_sms_verify(monkeypatch):
    monkeypatch.setenv('TELESIGN_CUSTOMER_ID', 'customer-id')
    monkeypatch.setenv('TELESIGN_API_KEY', 'provider-secret')
    monkeypatch.setenv('OTP_SMS_ADAPTER', 'telesign_verify')
    captured = []

    def fake_urlopen(request, timeout):
        captured.append(request.full_url)
        if 'verify.telesign.com' in request.full_url:
            raw_body = json.dumps({
                'status': {
                    'code': 3906,
                    'description': 'Unified Verification Product not enabled',
                },
                'errors': [],
            }).encode('utf-8')
            raise urllib.error.HTTPError(
                request.full_url, 401, 'Unauthorized', {}, io.BytesIO(raw_body),
            )
        return FakeResponse({
            'reference_id': 'sms-verify-fallback-ref',
            'errors': [],
            'status': {'code': 290, 'description': 'Message in progress'},
        })

    monkeypatch.setattr(telesign_service.urllib.request, 'urlopen', fake_urlopen)
    result = asyncio.run(otp_service.TelesignVerifyAdapter().send(
        otp_service.Identity('SMS', '+919876543210'),
        '123456',
        otp_service.VERIFY_CONTACT,
    ))
    assert result == {
        'sent': True,
        'provider': 'telesign',
        'reference_id': 'sms-verify-fallback-ref',
        'status_code': 290,
    }
    assert any('verify.telesign.com' in url for url in captured)
    assert any('/v1/verify/sms' in url for url in captured)
    joined = ' '.join(captured)
    assert 'customer-id' not in joined
    assert 'provider-secret' not in joined
    assert '123456' not in joined


def test_verify_api_3906_email_falls_back_to_email_service(monkeypatch):
    monkeypatch.setenv('TELESIGN_CUSTOMER_ID', 'customer-id')
    monkeypatch.setenv('TELESIGN_API_KEY', 'provider-secret')
    monkeypatch.setenv('OTP_EMAIL_ADAPTER', 'telesign_verify')
    monkeypatch.setenv('EMAIL_PROVIDER', 'resend')
    monkeypatch.setenv('RESEND_API_KEY', 're_test')
    monkeypatch.setenv('SENDER_EMAIL', 'noreply@chakri.casino')

    def fake_urlopen(request, timeout):
        raw_body = json.dumps({
            'status': {'code': 3906, 'description': 'not enabled'},
            'errors': [],
        }).encode('utf-8')
        raise urllib.error.HTTPError(
            request.full_url, 401, 'Unauthorized', {}, io.BytesIO(raw_body),
        )

    async def fake_email_send(self, identity, code, purpose):
        assert identity.channel == 'EMAIL'
        assert purpose == otp_service.RESET_PASSWORD
        assert code == '654321'
        return {'sent': True, 'provider': 'resend'}

    monkeypatch.setattr(telesign_service.urllib.request, 'urlopen', fake_urlopen)
    monkeypatch.setattr(
        otp_service.EmailOtpAdapter, 'send', fake_email_send,
    )
    result = asyncio.run(otp_service.TelesignVerifyAdapter().send(
        otp_service.Identity('EMAIL', 'player@example.com'),
        '654321',
        otp_service.RESET_PASSWORD,
    ))
    assert result == {'sent': True, 'provider': 'resend'}


def test_classify_sms_verify_error_is_metadata_only():
    trial = telesign_service.TelesignServiceError(
        'HTTPError',
        http_status=401,
        provider_error_codes=(-10033,),
    )
    assert telesign_service.classify_sms_verify_error(trial) == (
        'trial_unverified_destination'
    )
    assert telesign_service.classify_sms_verify_error(
        telesign_service.TelesignServiceError(
            'HTTPError', provider_error_codes=(-20002,),
        )
    ) == 'product_not_enabled'
    assert telesign_service.classify_sms_verify_error(
        telesign_service.TelesignServiceError(
            'HTTPError', provider_error_codes=(-10009,),
        )
    ) == 'invalid_source_ip'
    assert telesign_service.classify_sms_verify_error(
        telesign_service.TelesignServiceError('provider_rejected')
    ) == 'provider_rejected'


def test_india_dlt_fields_are_forwarded_without_logging_secrets(monkeypatch):
    monkeypatch.setenv('TELESIGN_CUSTOMER_ID', 'customer-id-secret-sentinel')
    monkeypatch.setenv('TELESIGN_API_KEY', 'provider-key-secret-sentinel')
    monkeypatch.setenv('TELESIGN_DLT_TEMPLATE_ID', '1107163490000000001')
    monkeypatch.setenv('TELESIGN_DLT_ENTITY_ID', '1102000000000000001')
    monkeypatch.setenv('TELESIGN_SENDER_ID', 'CHAKRI')
    captured = {}

    def fake_urlopen(request, timeout):
        captured['request'] = request
        return FakeResponse({
            'reference_id': 'dlt-reference-id',
            'errors': [],
            'status': {'code': 290, 'description': 'Message in progress'},
        })

    monkeypatch.setattr(telesign_service.urllib.request, 'urlopen', fake_urlopen)
    result = asyncio.run(telesign_service.send_verify_sms(
        '+919876543210', '123456', otp_service.VERIFY_CONTACT,
    ))
    assert result == {
        'reference_id': 'dlt-reference-id',
        'status_code': 290,
    }
    body = urllib.parse.parse_qs(captured['request'].data.decode('utf-8'))
    assert body['phone_number'] == ['919876543210']
    assert body['dlt_template_id'] == ['1107163490000000001']
    assert body['dlt_entity_id'] == ['1102000000000000001']
    assert body['sender_id'] == ['CHAKRI']
    assert 'customer-id-secret-sentinel' not in captured['request'].data.decode('utf-8')


def test_invalid_dlt_env_is_ignored(monkeypatch):
    monkeypatch.setenv('TELESIGN_DLT_TEMPLATE_ID', 'not a valid id!')
    monkeypatch.setenv('TELESIGN_DLT_ENTITY_ID', 'also invalid')
    assert telesign_service.india_dlt_fields() == {}
    assert telesign_service.india_dlt_configured() is False
