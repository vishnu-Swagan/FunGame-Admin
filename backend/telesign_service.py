"""Server-side clients and readiness metadata for the Telesign product suite.

Provider credentials never cross an API boundary or enter application logs.
Product calls are separately gated because account access does not make API
traffic free, and because risk enforcement must fail closed while observation
mode may degrade without blocking legitimate users.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import urllib.parse
import urllib.request


VERIFY_SMS_URL = 'https://rest-ww.telesign.com/v1/verify/sms'
VERIFY_API_URL = 'https://verify.telesign.com/verification'
INTELLIGENCE_URL = 'https://detect.telesign.com/intelligence/phone'
PHONE_ID_URL = 'https://rest-ww.telesign.com/v1/phoneid/{phone_number}'
MAX_RESPONSE_BYTES = 65_536


class TelesignServiceError(Exception):
    """A metadata-only provider error safe to handle without exposing PII."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _truthy(name: str) -> bool:
    return (os.environ.get(name) or '').strip().lower() in {'1', 'true', 'yes', 'on'}


def _mode(name: str, default: str = 'disabled') -> str:
    value = (os.environ.get(name) or default).strip().lower()
    return value if value in {'disabled', 'observe', 'enforce'} else 'disabled'


def credentials_ready() -> bool:
    return bool(
        (os.environ.get('TELESIGN_CUSTOMER_ID') or '').strip()
        and (os.environ.get('TELESIGN_API_KEY') or '').strip()
    )


def product_status() -> dict:
    """Return non-secret operational state for the Admin integration panel."""
    credentials = credentials_ready()
    intelligence_mode = _mode('TELESIGN_INTELLIGENCE_MODE')
    phone_id_mode = _mode('TELESIGN_PHONE_ID_MODE')
    sms_adapter = (os.environ.get('OTP_SMS_ADAPTER') or 'disabled').strip().lower()
    email_adapter = (os.environ.get('OTP_EMAIL_ADAPTER') or 'disabled').strip().lower()
    return {
        'provider': 'telesign',
        'plan': (os.environ.get('TELESIGN_PLAN') or 'self-service').strip(),
        'credentials_ready': credentials,
        'products': {
            'intelligence': {
                'available': credentials,
                'enabled': credentials and intelligence_mode != 'disabled',
                'mode': intelligence_mode,
            },
            'phone_id': {
                'available': credentials,
                'enabled': credentials and phone_id_mode != 'disabled',
                'mode': phone_id_mode,
            },
            'contact_addon': {
                'available': credentials,
                'enabled': credentials and phone_id_mode != 'disabled'
                and _truthy('TELESIGN_CONTACT_ADDON_ENABLED'),
            },
            'sms': {
                'available': credentials,
                'enabled': credentials and _truthy('TELESIGN_ENGAGEMENT_SMS_ENABLED'),
            },
            'sms_verify': {
                'available': credentials,
                'enabled': credentials and sms_adapter == 'telesign',
            },
            'email_verify': {
                'available': credentials,
                'enabled': credentials and email_adapter in {
                    'telesign_verify', 'telesign-verify',
                },
            },
            'verify_plus': {
                'available': credentials,
                # Verify Plus is configured in My Telesign and then applies to
                # SMS Verify requests automatically; there is no second send.
                'enabled': credentials and sms_adapter == 'telesign'
                and _truthy('TELESIGN_VERIFY_PLUS_ENABLED'),
            },
        },
    }


def phone_digits(value: str) -> str:
    digits = re.sub(r'\D', '', str(value or ''))
    if not 8 <= len(digits) <= 15:
        raise TelesignServiceError('invalid_phone')
    return digits


def _authorization() -> str:
    customer_id = (os.environ.get('TELESIGN_CUSTOMER_ID') or '').strip()
    api_key = (os.environ.get('TELESIGN_API_KEY') or '').strip()
    if not customer_id or not api_key:
        raise TelesignServiceError('not_configured')
    encoded = base64.b64encode(f'{customer_id}:{api_key}'.encode('utf-8')).decode('ascii')
    return f'Basic {encoded}'


async def _request_json(
    url: str, *, body: bytes, content_type: str, method: str = 'POST',
) -> tuple[int, dict]:
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            'Accept': 'application/json',
            'Authorization': _authorization(),
            'Content-Type': content_type,
        },
        method=method,
    )

    def perform_request() -> tuple[int, bytes]:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, response.read(MAX_RESPONSE_BYTES + 1)

    try:
        http_status, raw_body = await asyncio.to_thread(perform_request)
    except Exception as exc:
        raise TelesignServiceError(type(exc).__name__) from exc
    if len(raw_body) > MAX_RESPONSE_BYTES:
        raise TelesignServiceError('response_too_large')
    try:
        parsed = json.loads(raw_body.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TelesignServiceError('invalid_response') from exc
    if not isinstance(parsed, dict):
        raise TelesignServiceError('invalid_response')
    return http_status, parsed


async def create_verification(
    destination: str, code: str, *, method: str, template_name: str | None = None,
) -> dict:
    """Create one full-service Verify API process with an app-owned OTP."""
    method = str(method or '').strip().lower()
    if method not in {'email', 'sms'}:
        raise TelesignServiceError('invalid_verification_method')
    recipient = (
        {'email': str(destination).strip().casefold()}
        if method == 'email'
        else {'phone_number': phone_digits(destination)}
    )
    payload = {
        'recipient': recipient,
        'security_factor': str(code),
        'verification_policy': [{'method': method}],
    }
    template = str(template_name or '').strip()
    if template:
        if not re.fullmatch(r'[a-z_]+', template):
            raise TelesignServiceError('invalid_template')
        payload['message_template'] = {'name': template}
    http_status, response = await _request_json(
        VERIFY_API_URL,
        body=json.dumps(payload, separators=(',', ':')).encode('utf-8'),
        content_type='application/json; charset=utf-8',
    )
    provider_code = (response.get('status') or {}).get('code')
    reference_id = str(response.get('reference_id') or '').strip()
    if not (
        200 <= http_status < 300
        and provider_code in {3900, 3901}
        and reference_id
        and not (response.get('errors') or [])
    ):
        raise TelesignServiceError('provider_rejected')
    return {'reference_id': reference_id, 'status_code': provider_code}


async def finalize_verification(reference_id: str, code: str) -> dict:
    """Report a successful app-owned OTP to the full-service Verify API."""
    reference = str(reference_id or '').strip()
    if not re.fullmatch(r'[A-Za-z0-9-]{16,80}', reference):
        raise TelesignServiceError('invalid_reference')
    http_status, response = await _request_json(
        f'{VERIFY_API_URL}/{reference}/state',
        body=json.dumps({
            'action': 'finalize',
            'security_factor': str(code),
        }, separators=(',', ':')).encode('utf-8'),
        content_type='application/json; charset=utf-8',
        method='PATCH',
    )
    provider_code = (response.get('status') or {}).get('code')
    if not (200 <= http_status < 300 and provider_code == 3900):
        raise TelesignServiceError('completion_rejected')
    return {'status_code': provider_code}


async def report_sms_completion(reference_id: str) -> dict:
    """Report a successful app-owned OTP to the legacy SMS Verify API."""
    reference = str(reference_id or '').strip()
    if not re.fullmatch(r'[A-Za-z0-9-]{8,80}', reference):
        raise TelesignServiceError('invalid_reference')
    http_status, response = await _request_json(
        f'https://rest-ww.telesign.com/v1/verify/completion/{reference}',
        body=b'',
        content_type='application/x-www-form-urlencoded; charset=utf-8',
        method='PUT',
    )
    provider_code = (response.get('status') or {}).get('code')
    if not (200 <= http_status < 300 and provider_code == 1900):
        raise TelesignServiceError('completion_rejected')
    return {'status_code': provider_code}


async def send_verify_sms(phone: str, code: str, purpose: str) -> dict:
    label = 'password reset' if purpose == 'RESET_PASSWORD' else 'verification'
    body = urllib.parse.urlencode({
        'phone_number': phone_digits(phone),
        'verify_code': code,
        'template': (
            f'Your Chakri.Casino {label} code is $$CODE$$. '
            'It expires in 15 minutes.'
        ),
    }).encode('utf-8')
    http_status, response = await _request_json(
        VERIFY_SMS_URL,
        body=body,
        content_type='application/x-www-form-urlencoded; charset=utf-8',
    )
    provider_code = (response.get('status') or {}).get('code')
    reference_id = str(response.get('reference_id') or '').strip()
    if not (
        200 <= http_status < 300
        and provider_code in {200, 203, 290}
        and not (response.get('errors') or [])
        and reference_id
    ):
        raise TelesignServiceError('provider_rejected')
    return {'reference_id': reference_id, 'status_code': provider_code}


def _risk_insights(value) -> dict:
    if not isinstance(value, dict):
        return {}
    safe = {}
    for key, items in value.items():
        if key == 'status' and isinstance(items, int):
            safe[key] = items
        elif isinstance(items, list):
            safe[key] = [item for item in items[:20] if isinstance(item, int)]
    return safe


async def evaluate_phone(
    phone: str,
    lifecycle_event: str,
    *,
    account_id: str | None = None,
    email_address: str | None = None,
    originating_ip: str | None = None,
) -> dict:
    if lifecycle_event not in {'create', 'sign-in', 'transact', 'update', 'delete'}:
        raise TelesignServiceError('invalid_lifecycle_event')
    fields = {
        'phone_number': phone_digits(phone),
        'account_lifecycle_event': lifecycle_event,
    }
    if account_id:
        fields['account_id'] = str(account_id)[:100]
    if email_address:
        fields['email_address'] = str(email_address)[:254]
    if originating_ip:
        fields['originating_ip'] = str(originating_ip)
    http_status, response = await _request_json(
        INTELLIGENCE_URL,
        body=urllib.parse.urlencode(fields).encode('utf-8'),
        content_type='application/x-www-form-urlencoded; charset=utf-8',
    )
    provider_code = (response.get('status') or {}).get('code')
    risk = response.get('risk') or {}
    if not (
        200 <= http_status < 300
        and provider_code in {300, 301}
        and risk.get('recommendation') in {'allow', 'flag', 'block'}
    ):
        raise TelesignServiceError('provider_rejected')
    phone_type = response.get('phone_type') or {}
    location = response.get('location') or {}
    country = location.get('country') or {}
    carrier = response.get('carrier') or {}
    return {
        'reference_id': str(response.get('reference_id') or ''),
        'status_code': provider_code,
        'risk': {
            'score': risk.get('score'),
            'level': risk.get('level'),
            'recommendation': risk.get('recommendation'),
        },
        'phone_type': {
            'code': phone_type.get('code'),
            'description': phone_type.get('description'),
        },
        'carrier': {'name': carrier.get('name')},
        'country': {'iso2': country.get('iso2'), 'iso3': country.get('iso3')},
        'risk_insights': _risk_insights(response.get('risk_insights')),
    }


async def phone_id_contact(phone: str, *, include_contact: bool = False) -> dict:
    payload = {'addons': {'contact': {}}} if include_contact else {}
    http_status, response = await _request_json(
        PHONE_ID_URL.format(phone_number=phone_digits(phone)),
        body=json.dumps(payload, separators=(',', ':')).encode('utf-8'),
        content_type='application/json',
    )
    provider_code = (response.get('status') or {}).get('code')
    if not (200 <= http_status < 300 and provider_code in {300, 301}):
        raise TelesignServiceError('provider_rejected')
    phone_type = response.get('phone_type') or {}
    location = response.get('location') or {}
    country = location.get('country') or {}
    carrier = response.get('carrier') or {}
    contact = response.get('contact') or {}
    contact_status = contact.get('status') or {}
    # Contact names, addresses and email addresses are deliberately discarded.
    # The Admin only needs proof of add-on completion and phone metadata.
    return {
        'reference_id': str(response.get('reference_id') or ''),
        'status_code': provider_code,
        'phone_type': {
            'code': phone_type.get('code'),
            'description': phone_type.get('description'),
        },
        'carrier': {'name': carrier.get('name')},
        'country': {'iso2': country.get('iso2'), 'iso3': country.get('iso3')},
        'contact_addon': {
            'requested': include_contact,
            'status_code': contact_status.get('code'),
            'available': contact_status.get('code') == 2800,
        },
    }
