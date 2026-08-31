"""Focused checks for mandatory phone-OTP self-service registration."""
import asyncio
import os
import sys
import types

from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient
from pydantic import ValidationError


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

client = AsyncMongoMockClient()
database = client['phone_otp_registration_test']
sys.modules['db'] = types.SimpleNamespace(
    db=database,
    client=client,
    serialize_doc=lambda value: {
        key: item for key, item in value.items()
        if key not in ('_id', 'password_hash')
    } if isinstance(value, dict) else value,
)

os.environ['APP_ENV'] = 'test'
os.environ['JWT_SECRET'] = 'test-only-jwt-secret-with-at-least-32-characters'
os.environ['OTP_PEPPER'] = 'test-only-otp-pepper-with-at-least-32-characters'
os.environ['OTP_EMAIL_ADAPTER'] = 'disabled'
os.environ['OTP_SMS_ADAPTER'] = 'mock'
os.environ['OTP_EXPOSE_DEV_CODE'] = 'true'
os.environ['AUTH_ALLOW_NON_TRANSACTIONAL_TESTS'] = 'true'
os.environ['REGISTRATION_MODE'] = 'PHONE_OTP'
# This registration regression intentionally exercises the retired request
# workflow after activation; enable it explicitly instead of relying on a
# permissive test default.
os.environ['LEGACY_CHIP_REQUESTS_ENABLED'] = 'true'
# A stale production setting must not reopen the retired no-OTP path.
os.environ['SELF_SERVICE_NO_OTP_ENABLED'] = 'true'

import auth_utils
import crm
import otp_service
import routes_admin
import routes_auth
import routes_player
from models import (
    ChipRequestCreate,
    LoginRequest,
    PlayerProfileUpdate,
    RegisterRequest,
    ResendVerificationRequest,
    SettingsUpdate,
    VerifyEmailRequest,
)


async def expect_http_error(coro, status, code=None):
    try:
        await coro
    except HTTPException as exc:
        assert exc.status_code == status, (exc.status_code, status, exc.detail)
        if code:
            assert isinstance(exc.detail, dict), exc.detail
            assert exc.detail.get('code') == code, exc.detail
        return exc
    raise AssertionError(f'Expected HTTP {status}')


def registration(**overrides):
    values = {
        'channel': 'PHONE',
        'identifier': '+919876543210',
        'phone': '+919876543210',
        'email': 'new.player@example.com',
        'full_name': 'New Player',
        'date_of_birth': '1990-01-01',
        'country': 'India',
        'accepted_terms': True,
    }
    values.update(overrides)
    return RegisterRequest(**values)


async def main():
    await otp_service.ensure_identity_indexes(database=database)
    await otp_service.ensure_indexes(database=database)
    await crm.ensure_indexes()
    await crm.ensure_house_account()

    capabilities = await routes_auth.authentication_capabilities()
    assert capabilities['registration_enabled'] is True
    assert capabilities['email_registration'] is False
    assert capabilities['phone_registration'] is True
    assert capabilities['phone_verification_required'] is True
    assert capabilities['verification_required'] is True
    assert capabilities['registration_mode'] == routes_auth.PHONE_OTP_ACTIVATION_MODE

    # Email cannot be used as an activation identity and a password is not
    # accepted before the phone OTP is proved.
    try:
        RegisterRequest(
            channel='EMAIL', identifier='email-only@example.com',
            email='email-only@example.com', full_name='Email Only',
            date_of_birth='1990-01-01', country='India', accepted_terms=True,
        )
        raise AssertionError('Email-only registration was accepted')
    except ValidationError:
        pass
    try:
        registration(password='Password-Must-Wait-9')
        raise AssertionError('Pre-verification password was accepted')
    except ValidationError:
        pass

    await expect_http_error(
        routes_auth.register(registration(accepted_terms=False)),
        422, 'TERMS_REQUIRED',
    )
    await expect_http_error(
        routes_auth.register(registration(date_of_birth=None)),
        422, 'AGE_UNKNOWN',
    )
    await expect_http_error(
        routes_auth.register(registration(country='not a real country 123')),
        422, 'COUNTRY_REQUIRED',
    )

    class FailingSmsAdapter:
        async def send(self, identity, code, purpose):
            return {'sent': False, 'provider': 'test-failure'}

    original_adapter = otp_service.delivery_adapter
    otp_service.delivery_adapter = lambda channel: FailingSmsAdapter()
    try:
        await expect_http_error(routes_auth.register(registration(
            identifier='+919876543212', phone='+919876543212',
            email='delivery.failure@example.com',
        )), 503, 'OTP_UNAVAILABLE')
    finally:
        otp_service.delivery_adapter = original_adapter
    assert await database.users.count_documents({
        'phone_normalized': '+919876543212',
    }) == 0
    assert await database.player_attribution.count_documents({
        'attributed_by': 'self-registration-phone-otp',
    }) == 0
    assert await database.otp_challenges.count_documents({
        'user_id': {'$exists': True},
    }) == 0

    challenge = await routes_auth.register(registration())
    assert challenge['message'] == routes_auth.GENERIC_REGISTER_MESSAGE
    assert challenge['verification_required'] is True
    assert challenge['channel'] == 'PHONE'
    assert challenge['dev_code']
    assert 'access_token' not in challenge

    player = await database.users.find_one({'phone_normalized': '+919876543210'})
    assert player['status'] == 'PENDING'
    assert player['activation_mode'] == routes_auth.PHONE_OTP_ACTIVATION_MODE
    assert player['contact_verification_status'] == 'PENDING'
    assert player['contact_verified'] is False
    assert player['phone_verified'] is False
    assert player['email_verified'] is False
    assert player['email_normalized'] == 'new.player@example.com'
    assert player['accepted_terms'] is True
    assert player['chip_balance'] == 0
    assert 'password_hash' not in player
    assert await database.player_attribution.count_documents({
        'user_id': player['id'], 'active': True,
        'distributor_code': crm.HOUSE_CODE,
        'attributed_by': 'self-registration-phone-otp',
    }) == 1

    await expect_http_error(routes_auth.resend_verification(
        ResendVerificationRequest(
            channel='EMAIL', identifier='new.player@example.com',
            email='new.player@example.com',
        ),
    ), 422, 'PHONE_REQUIRED')

    # There is no credential to log in with until OTP verification commits the
    # user-selected password.
    await expect_http_error(routes_auth.login(LoginRequest(
        identifier='+919876543210', phone='+919876543210',
        password='Any-Password-9',
    )), 401)

    verified = await routes_auth.verify_contact(VerifyEmailRequest(
        channel='PHONE', identifier='+919876543210', phone='+919876543210',
        code=challenge['dev_code'], password='Verified-Password-9',
    ))
    assert verified['access_token']
    assert verified['user']['status'] == 'ACTIVE'
    assert verified['user']['phone_verified'] is True
    assert verified['user']['email_verified'] is False

    player = await database.users.find_one({'id': player['id']})
    assert player['status'] == 'ACTIVE'
    assert player['contact_verified'] is True
    assert player['phone_verified'] is True
    assert player['email_verified'] is False
    assert player['approved_by'] == 'SELF_SERVICE_PHONE_OTP'
    assert player['approved_at'] == player['activated_at']
    assert auth_utils.verify_password('Verified-Password-9', player['password_hash'])

    challenge_count = await database.otp_challenges.count_documents({})
    existing_phone = await routes_auth.register(registration())
    email_collision = await routes_auth.register(registration(
        identifier='+919876543211', phone='+919876543211',
    ))
    assert set(existing_phone) == set(email_collision)
    assert existing_phone['message'] == routes_auth.GENERIC_REGISTER_MESSAGE
    assert email_collision['message'] == routes_auth.GENERIC_REGISTER_MESSAGE
    assert existing_phone['verification_required'] is True
    assert email_collision['verification_required'] is True
    assert existing_phone['channel'] == email_collision['channel'] == 'PHONE'
    assert existing_phone['destination'] != email_collision['destination']
    assert 'dev_code' not in existing_phone and 'dev_code' not in email_collision
    assert await database.users.count_documents({
        'phone_normalized': '+919876543211',
    }) == 0
    assert await database.otp_challenges.count_documents({}) == challenge_count

    login = await routes_auth.login(LoginRequest(
        identifier='+919876543210', phone='+919876543210',
        password='Verified-Password-9',
    ))
    assert login['access_token']

    # Optional email is unverified profile data, never an alternative login
    # identity for an account whose ownership was proved only by phone OTP.
    await expect_http_error(routes_auth.login(LoginRequest(
        identifier='new.player@example.com', email='new.player@example.com',
        password='Verified-Password-9',
    )), 401)

    # Existing profile/settings/chip-request features remain available to the
    # newly activated account and preserve a zero starting balance.
    profile_result = await routes_player.update_profile(
        PlayerProfileUpdate(display_name='Lucky New Player', avatar='crown'),
        user=player,
    )
    assert profile_result['profile']['display_name'] == 'Lucky New Player'
    profile_row = await database.users.find_one({'id': player['id']})
    assert profile_row['email'] == 'new.player@example.com'
    assert profile_row['email_verified'] is False

    settings = await routes_player.update_settings(
        SettingsUpdate(sound_enabled=False, high_contrast=True), user=profile_row,
    )
    assert settings['settings']['sound_enabled'] is False

    chip = await routes_player.create_chip_request(
        ChipRequestCreate(amount=500, note='First request'), user=profile_row,
    )
    assert chip['request']['status'] == 'PENDING'
    assert chip['request']['user_phone'] == '+919876543210'
    assert chip['request']['user_email'] == 'new.player@example.com'
    assert (await database.users.find_one({'id': player['id']}))['chip_balance'] == 0

    listed = await routes_admin.list_users(
        status='ACTIVE', admin={'id': 'admin-1', 'role': 'ADMIN', 'status': 'ACTIVE'},
    )
    crm_player = next(item for item in listed['users'] if item['id'] == player['id'])
    assert crm_player['activation_mode'] == routes_auth.PHONE_OTP_ACTIVATION_MODE
    assert crm_player['contact_verification_status'] == 'VERIFIED'
    assert crm_player['phone_verified'] is True
    assert crm_player['email_verified'] is False
    assert 'password_hash' not in crm_player

    # New dual-verification registrations require both independently delivered
    # codes, while the phone-only account above keeps its original contract.
    os.environ['REGISTRATION_EMAIL_OTP_REQUIRED'] = 'true'
    os.environ['OTP_EMAIL_ADAPTER'] = 'mock'
    dual_capabilities = await routes_auth.authentication_capabilities()
    assert dual_capabilities['registration_enabled'] is True
    assert dual_capabilities['email_contact_verification'] is True
    assert dual_capabilities['email_verification_required'] is True

    dual_phone = '+919876543213'
    dual_email = 'dual.player@example.com'
    dual_challenge = await routes_auth.register(registration(
        identifier=dual_phone, phone=dual_phone, email=dual_email,
    ))
    phone_result = await routes_auth.verify_contact(VerifyEmailRequest(
        channel='PHONE', identifier=dual_phone, phone=dual_phone,
        code=dual_challenge['dev_code'], password='Dual-Verified-Password-9',
    ))
    assert 'access_token' not in phone_result
    assert phone_result['next_verification']['channel'] == 'EMAIL'
    assert phone_result['next_verification']['dev_code']
    dual_row = await database.users.find_one({'phone_normalized': dual_phone})
    assert dual_row['status'] == 'PENDING'
    assert dual_row['phone_verified'] is True
    assert dual_row['email_verified'] is False
    assert dual_row['contact_verified'] is False

    pending_login = await expect_http_error(routes_auth.login(LoginRequest(
        identifier=dual_phone, phone=dual_phone,
        password='Dual-Verified-Password-9',
    )), 403, 'CONTACT_NOT_VERIFIED')
    assert pending_login.detail['channel'] == 'EMAIL'
    assert pending_login.detail['identifier'] == dual_email

    dual_verified = await routes_auth.verify_contact(VerifyEmailRequest(
        channel='EMAIL', identifier=dual_email, email=dual_email,
        code=phone_result['next_verification']['dev_code'],
        password='Dual-Verified-Password-9',
    ))
    assert dual_verified['access_token']
    assert dual_verified['user']['status'] == 'ACTIVE'
    assert dual_verified['user']['phone_verified'] is True
    assert dual_verified['user']['email_verified'] is True
    dual_row = await database.users.find_one({'phone_normalized': dual_phone})
    assert dual_row['contact_verified'] is True
    assert dual_row['approved_by'] == 'SELF_SERVICE_PHONE_EMAIL_OTP'

    print('Phone OTP registration: all focused checks passed')


if __name__ == '__main__':
    asyncio.run(main())
