"""Server-side clients and readiness metadata for the Telesign product suite.

Provider credentials never cross an API boundary or enter application logs.
Product calls are separately gated because account access does not make API
traffic free, and because risk enforcement must fail closed while observation
mode may degrade without blocking legitimate users.
"""
from __future__ import annotations

import asyncio
import base64
from datetime import timezone
from email.utils import format_datetime, parsedate_to_datetime
import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request


logger = logging.getLogger('telesign')

# Provider error codes that are safe to classify without reading descriptions.
# Descriptions can contain the destination or OTP and must never be logged.
TRIAL_UNVERIFIED_DESTINATION = -10033
PRODUCT_NOT_ENABLED = -20002
INVALID_SOURCE_IP = -10009
DLT_FIELD_MAX_LENGTH = 40
SENDER_ID_MAX_LENGTH = 20


VERIFY_SMS_URL = 'https://rest-ww.telesign.com/v1/verify/sms'
VERIFY_API_URL = 'https://verify.telesign.com/verification'
INTELLIGENCE_URL = 'https://detect.telesign.com/intelligence/phone'
PHONE_ID_URL = 'https://rest-ww.telesign.com/v1/phoneid/{phone_number}'
MAX_RESPONSE_BYTES = 65_536
MAX_PROVIDER_ERROR_CODES = 20
MAX_PROVIDER_CODE = 2_147_483_647
MAX_RETRY_AFTER_SECONDS = 2_147_483_647
MAX_RETRY_AFTER_LENGTH = 128


def _safe_http_status(value) -> int | None:
    if type(value) is int and 100 <= value <= 599:
        return value
    return None


def _safe_provider_status_code(value) -> int | None:
    if type(value) is int and 0 <= value <= MAX_PROVIDER_CODE:
        return value
    return None


def _safe_provider_error_code(value) -> int | None:
    if type(value) is int and -MAX_PROVIDER_CODE <= value <= MAX_PROVIDER_CODE:
        return value
    return None


def _safe_provider_error_codes(values) -> tuple[int, ...]:
    if not isinstance(values, (list, tuple)):
        return ()
    codes = []
    for value in values[:MAX_PROVIDER_ERROR_CODES]:
        code = _safe_provider_error_code(value)
        if code is not None:
            codes.append(code)
    return tuple(codes)


def _safe_retry_after(value) -> str | None:
    if type(value) is int:
        value = str(value)
    if not isinstance(value, str) or len(value) > MAX_RETRY_AFTER_LENGTH:
        return None
    stripped = value.strip()
    if '\r' in stripped or '\n' in stripped:
        return None
    if re.fullmatch(r'\d{1,10}', stripped):
        seconds = int(stripped)
        if not 0 <= seconds <= MAX_RETRY_AFTER_SECONDS:
            return None
        return str(seconds)
    try:
        parsed = parsedate_to_datetime(stripped)
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed is None or parsed.tzinfo is None or not 1900 <= parsed.year <= 9999:
        return None
    try:
        return format_datetime(parsed.astimezone(timezone.utc), usegmt=True)
    except (ValueError, OverflowError):
        return None


def _provider_response_codes(payload) -> tuple[int | None, tuple[int, ...]]:
    if not isinstance(payload, dict):
        return None, ()
    status = payload.get('status')
    provider_status_code = _safe_provider_status_code(
        status.get('code') if isinstance(status, dict) else None,
    )
    errors = payload.get('errors')
    if not isinstance(errors, list):
        return provider_status_code, ()
    provider_error_codes = []
    for item in errors[:MAX_PROVIDER_ERROR_CODES]:
        code = _safe_provider_error_code(
            item.get('code') if isinstance(item, dict) else None,
        )
        if code is not None:
            provider_error_codes.append(code)
    return provider_status_code, tuple(provider_error_codes)


class TelesignServiceError(Exception):
    """A metadata-only provider error safe to handle without exposing PII."""

    def __init__(
        self,
        reason: str,
        *,
        http_status=None,
        provider_status_code=None,
        provider_error_codes=(),
        retry_after=None,
    ):
        super().__init__(reason)
        self.reason = reason
        self.http_status = _safe_http_status(http_status)
        self.provider_status_code = _safe_provider_status_code(
            provider_status_code,
        )
        self.provider_error_codes = _safe_provider_error_codes(
            provider_error_codes,
        )
        self.retry_after = _safe_retry_after(retry_after)
        self.metadata = {
            key: value for key, value in {
                'http_status': self.http_status,
                'provider_status_code': self.provider_status_code,
                'provider_error_codes': self.provider_error_codes,
                'retry_after': self.retry_after,
            }.items() if value not in (None, ())
        }


def classify_sms_verify_error(error: TelesignServiceError) -> str:
    """Map a provider failure to a stable, non-PII diagnostic token."""
    codes = set(error.provider_error_codes or ())
    if TRIAL_UNVERIFIED_DESTINATION in codes:
        return 'trial_unverified_destination'
    if PRODUCT_NOT_ENABLED in codes:
        return 'product_not_enabled'
    if INVALID_SOURCE_IP in codes:
        return 'invalid_source_ip'
    if error.reason:
        return str(error.reason)[:80]
    return 'provider_rejected'


def _optional_provider_field(name: str, *, max_length: int, pattern: str) -> str:
    value = (os.environ.get(name) or '').strip()
    if not value:
        return ''
    if len(value) > max_length or not re.fullmatch(pattern, value):
        logger.error('Ignoring invalid %s (length or charset)', name)
        return ''
    return value


def india_dlt_fields() -> dict:
    """Return configured India DLT fields, omitting anything invalid or empty."""
    fields = {}
    template_id = _optional_provider_field(
        'TELESIGN_DLT_TEMPLATE_ID',
        max_length=DLT_FIELD_MAX_LENGTH,
        pattern=r'[A-Za-z0-9]+',
    )
    entity_id = _optional_provider_field(
        'TELESIGN_DLT_ENTITY_ID',
        max_length=DLT_FIELD_MAX_LENGTH,
        pattern=r'[A-Za-z0-9]+',
    )
    sender_id = _optional_provider_field(
        'TELESIGN_SENDER_ID',
        max_length=SENDER_ID_MAX_LENGTH,
        pattern=r'[A-Za-z0-9]+',
    )
    if template_id:
        fields['dlt_template_id'] = template_id
    if entity_id:
        fields['dlt_entity_id'] = entity_id
    if sender_id:
        fields['sender_id'] = sender_id
    return fields


def india_dlt_configured() -> bool:
    fields = india_dlt_fields()
    return bool(fields.get('dlt_template_id') and fields.get('dlt_entity_id'))


def verify_api_unavailable(error: TelesignServiceError) -> bool:
    """True when Unified Verify is not enabled for this Customer ID.

    HTTP 401 + status 3906 means the Verify API (verify.telesign.com) is not
    on the contract. Self-service accounts still have SMS Verify
    (rest-ww.telesign.com/v1/verify/sms). This is a product-gate, not a
    leaked credential.
    """
    return (
        error.http_status == 401
        and error.provider_status_code == 3906
    )


def _provider_response_error(
    reason: str, http_status, payload, *, retry_after=None,
) -> TelesignServiceError:
    provider_status_code, provider_error_codes = _provider_response_codes(payload)
    return TelesignServiceError(
        reason,
        http_status=http_status,
        provider_status_code=provider_status_code,
        provider_error_codes=provider_error_codes,
        retry_after=retry_after,
    )


def _http_error(error: urllib.error.HTTPError) -> TelesignServiceError:
    """Extract bounded, non-sensitive metadata from one urllib HTTP failure."""
    try:
        retry_after_values = (
            error.headers.get_all('Retry-After')
            if error.headers and hasattr(error.headers, 'get_all') else None
        )
        if retry_after_values is not None:
            retry_after = (
                retry_after_values[0] if len(retry_after_values) == 1 else None
            )
        else:
            retry_after = (
                error.headers.get('Retry-After') if error.headers else None
            )
    except Exception:
        retry_after = None
    try:
        raw_body = error.read(MAX_RESPONSE_BYTES + 1)
    except Exception:
        raw_body = b''
    finally:
        try:
            error.close()
        except Exception:
            pass

    payload = None
    if isinstance(raw_body, bytes) and len(raw_body) <= MAX_RESPONSE_BYTES:
        try:
            candidate = json.loads(raw_body.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass
        else:
            if isinstance(candidate, dict):
                payload = candidate
    return _provider_response_error(
        type(error).__name__, error.code, payload, retry_after=retry_after,
    )


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

    request_error = None
    try:
        http_status, raw_body = await asyncio.to_thread(perform_request)
    except urllib.error.HTTPError as exc:
        # Extract and close the raw error here, then raise after leaving this
        # handler so the HTTPError body/request cannot remain as exception
        # context reachable by callers or logging infrastructure.
        request_error = _http_error(exc)
    except Exception as exc:
        request_error = TelesignServiceError(type(exc).__name__)
    if request_error is not None:
        raise request_error
    if len(raw_body) > MAX_RESPONSE_BYTES:
        raise TelesignServiceError('response_too_large')
    try:
        parsed = json.loads(raw_body.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        parsed = None
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
    provider_code, _ = _provider_response_codes(response)
    reference_id = str(response.get('reference_id') or '').strip()
    if not (
        200 <= http_status < 300
        and provider_code in {3900, 3901}
        and reference_id
        and not (response.get('errors') or [])
    ):
        raise _provider_response_error('provider_rejected', http_status, response)
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
    provider_code, _ = _provider_response_codes(response)
    if not (200 <= http_status < 300 and provider_code == 3900):
        raise _provider_response_error('completion_rejected', http_status, response)
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
    provider_code, _ = _provider_response_codes(response)
    if not (200 <= http_status < 300 and provider_code == 1900):
        raise _provider_response_error('completion_rejected', http_status, response)
    return {'status_code': provider_code}


async def send_verify_sms(phone: str, code: str, purpose: str) -> dict:
    label = 'password reset' if purpose == 'RESET_PASSWORD' else 'verification'
    digits = phone_digits(phone)
    destination_region = 'IN' if digits.startswith('91') and len(digits) == 12 else 'other'
    dlt = india_dlt_fields()
    if destination_region == 'IN' and not india_dlt_configured():
        logger.warning(
            'Telesign SMS Verify to IN without DLT ids; Indian carriers may drop the message',
        )
    fields = {
        'phone_number': digits,
        'verify_code': code,
        'template': (
            f'Your Chakri.Casino {label} code is $$CODE$$. '
            'It expires in 15 minutes.'
        ),
        **dlt,
    }
    logger.info(
        'Telesign SMS Verify request: purpose=%s region=%s dlt=%s sender=%s',
        purpose,
        destination_region,
        'configured' if india_dlt_configured() else 'absent',
        'configured' if dlt.get('sender_id') else 'absent',
    )
    body = urllib.parse.urlencode(fields).encode('utf-8')
    http_status, response = await _request_json(
        VERIFY_SMS_URL,
        body=body,
        content_type='application/x-www-form-urlencoded; charset=utf-8',
    )
    provider_code, _ = _provider_response_codes(response)
    reference_id = str(response.get('reference_id') or '').strip()
    if not (
        200 <= http_status < 300
        and provider_code in {200, 203, 290}
        and not (response.get('errors') or [])
        and reference_id
    ):
        raise _provider_response_error('provider_rejected', http_status, response)
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
    provider_code, _ = _provider_response_codes(response)
    risk = response.get('risk') or {}
    if not (
        200 <= http_status < 300
        and provider_code in {300, 301}
        and risk.get('recommendation') in {'allow', 'flag', 'block'}
    ):
        raise _provider_response_error('provider_rejected', http_status, response)
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
    provider_code, _ = _provider_response_codes(response)
    if not (200 <= http_status < 300 and provider_code in {300, 301}):
        raise _provider_response_error('provider_rejected', http_status, response)
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
