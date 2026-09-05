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
        'username': 'Default.Player',
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
    assert capabilities['email_verification_required'] is False
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
    auto_phone = '+919876543219'
    auto_challenge = await routes_auth.register(registration(
        identifier=auto_phone, phone=auto_phone,
        email='missing.login.id@example.com', username=None,
    ))
    assert auto_challenge['verification_required'] is True
    auto_row = await database.users.find_one({'phone_normalized': auto_phone})
    assert auto_row['requested_username'] == 'p919876543219'
    assert auto_row['email_verification_required'] is False

    class FailingSmsAdapter:
        async def send(self, identity, code, purpose):
            return {'sent': False, 'provider': 'test-failure'}

    original_adapter = otp_service.delivery_adapter
    otp_service.delivery_adapter = lambda channel: FailingSmsAdapter()
    try:
        failed_delivery = await routes_auth.register(registration(
            identifier='+919876543212', phone='+919876543212',
            email='delivery.failure@example.com',
            username='Delivery.Failure',
        ))
    finally:
        otp_service.delivery_adapter = original_adapter
    assert failed_delivery['verification_required'] is True
    assert failed_delivery['message'] == routes_auth.GENERIC_REGISTER_MESSAGE
    assert 'access_token' not in failed_delivery
    stalled = await database.users.find_one({'phone_normalized': '+919876543212'})
    assert stalled is not None
    assert stalled['status'] == 'PENDING'
    assert stalled['phone_verified'] is False
    assert stalled['activation_mode'] == routes_auth.PHONE_OTP_ACTIVATION_MODE
    assert 'password_hash' not in stalled
    assert await database.player_attribution.count_documents({
        'user_id': stalled['id'],
        'attributed_by': 'self-registration-phone-otp',
    }) == 1
    assert await database.login_id_reservations.count_documents({
        'key': 'delivery.failure',
    }) == 0

    reserved_login_unknown = await expect_http_error(routes_auth.register(registration(
        identifier='+919876543216', phone='+919876543216',
        email='reserved.login@example.com', username='ADM1N',
    )), 409, 'LOGIN_ID_UNAVAILABLE')
    assert await database.users.find_one({
        'phone_normalized': '+919876543216',
    }) is None

    challenge = await routes_auth.register(registration(username='Lucky.Player_7'))
    assert challenge['message'] == routes_auth.GENERIC_REGISTER_MESSAGE
    assert challenge['verification_required'] is True
    assert challenge['channel'] == 'PHONE'
    assert challenge['dev_code']
    assert 'access_token' not in challenge
    resume_without_login = await routes_auth.register(registration(username=None))
    assert resume_without_login['verification_required'] is True
    assert resume_without_login['message'] == routes_auth.GENERIC_REGISTER_MESSAGE
    reserved_login_known = await expect_http_error(
        routes_auth.register(registration(username='ADM1N')),
        409, 'LOGIN_ID_UNAVAILABLE',
    )
    assert reserved_login_known.detail == reserved_login_unknown.detail

    player = await database.users.find_one({'phone_normalized': '+919876543210'})
    assert player['status'] == 'PENDING'
    assert player['activation_mode'] == routes_auth.PHONE_OTP_ACTIVATION_MODE
    assert player['contact_verification_status'] == 'PENDING'
    assert player['contact_verified'] is False
    assert player['phone_verified'] is False
    assert player['email_verified'] is False
    assert player['email_normalized'] == 'new.player@example.com'
    assert player['requested_username'] == 'Lucky.Player_7'
    assert 'username' not in player
    assert await database.login_id_reservations.count_documents({
        'key': 'lucky.player_7',
    }) == 0
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
    assert player['username'] == 'Lucky.Player_7'
    assert player['username_key'] == 'lucky.player_7'
    assert 'requested_username' not in player
    assert await database.login_id_reservations.count_documents({
        'key': 'lucky.player_7', 'owner_type': 'USER', 'owner_id': player['id'],
    }) == 1

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

    login_by_id = await routes_auth.login(LoginRequest(
        identifier='lucky.player_7', email='lucky.player_7',
        password='Verified-Password-9',
    ))
    assert login_by_id['access_token']

    await expect_http_error(routes_auth.register(registration(
        identifier='+919876543214', phone='+919876543214',
        email='different.player@example.com', username='LUCKY.PLAYER_7',
    )), 409, 'LOGIN_ID_UNAVAILABLE')
    assert await database.users.find_one({
        'phone_normalized': '+919876543214',
    }) is None

    # Pending submissions do not squat a Login ID. The first verified account
    # claims it; a concurrent contender receives a conflict and can retry the
    # same unconsumed OTP with another ID because production wraps consumption
    # and reservation in one Mongo transaction.
    claim_one = await routes_auth.register(registration(
        identifier='+919876543217', phone='+919876543217',
        email='claim.one@example.com', username='Shared.Player',
    ))
    claim_two = await routes_auth.register(registration(
        identifier='+919876543218', phone='+919876543218',
        email='claim.two@example.com', username='Shared.Player',
    ))
    await routes_auth.verify_contact(VerifyEmailRequest(
        channel='PHONE', identifier='+919876543217', phone='+919876543217',
        code=claim_one['dev_code'], password='Claim-One-Password-9',
    ))

    original_transaction_runner = routes_auth._run_auth_transaction

    async def rollback_capable_test_transaction(callback):
        collection_names = ('users', 'otp_challenges', 'login_id_reservations')
        snapshots = {
            name: await database[name].find({}).to_list(length=None)
            for name in collection_names
        }
        try:
            return await callback(None)
        except Exception:
            for name in collection_names:
                await database[name].delete_many({})
                if snapshots[name]:
                    await database[name].insert_many(snapshots[name])
            raise

    routes_auth._run_auth_transaction = rollback_capable_test_transaction
    try:
        await expect_http_error(routes_auth.verify_contact(VerifyEmailRequest(
            channel='PHONE', identifier='+919876543218', phone='+919876543218',
            code=claim_two['dev_code'], password='Claim-Two-Password-9',
        )), 409, 'LOGIN_ID_UNAVAILABLE')
        claim_retry = await routes_auth.verify_contact(VerifyEmailRequest(
            channel='PHONE', identifier='+919876543218', phone='+919876543218',
            username='Shared.Player.2',
            code=claim_two['dev_code'], password='Claim-Two-Password-9',
        ))
    finally:
        routes_auth._run_auth_transaction = original_transaction_runner
    assert claim_retry['access_token']
    claim_two_row = await database.users.find_one({
        'phone_normalized': '+919876543218',
    })
    assert claim_two_row['username'] == 'Shared.Player.2'
    assert claim_two_row['username_key'] == 'shared.player.2'

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

    # A stale REGISTRATION_EMAIL_OTP_REQUIRED flag must not reopen dual OTP.
    os.environ['REGISTRATION_EMAIL_OTP_REQUIRED'] = 'true'
    os.environ['OTP_EMAIL_ADAPTER'] = 'mock'
    dual_capabilities = await routes_auth.authentication_capabilities()
    assert dual_capabilities['registration_enabled'] is True
    assert dual_capabilities['email_contact_verification'] is True
    assert dual_capabilities['email_verification_required'] is False

    dual_phone = '+919876543213'
    dual_email = 'dual.player@example.com'
    dual_challenge = await routes_auth.register(registration(
        identifier=dual_phone, phone=dual_phone, email=dual_email,
        username='Dual.Player',
    ))
    phone_result = await routes_auth.verify_contact(VerifyEmailRequest(
        channel='PHONE', identifier=dual_phone, phone=dual_phone,
        username='Dual.Player.Edited',
        code=dual_challenge['dev_code'], password='Dual-Verified-Password-9',
    ))
    assert phone_result['access_token']
    assert 'next_verification' not in phone_result
    dual_row = await database.users.find_one({'phone_normalized': dual_phone})
    assert dual_row['status'] == 'ACTIVE'
    assert dual_row['phone_verified'] is True
    assert dual_row['email_verified'] is False
    assert dual_row['contact_verified'] is True
    assert dual_row['approved_by'] == 'SELF_SERVICE_PHONE_OTP'
    assert dual_row['username'] == 'Dual.Player.Edited'
    assert dual_row['username_key'] == 'dual.player.edited'
    assert 'requested_username' not in dual_row

    # Leftover per-user email_verification_required must not block SMS
    # activation or later login.
    leftover_phone = '+919876543214'
    leftover_challenge = await routes_auth.register(registration(
        identifier=leftover_phone, phone=leftover_phone,
        email='leftover.dual@example.com', username='Leftover.Dual',
    ))
    leftover_row = await database.users.find_one({'phone_normalized': leftover_phone})
    await database.users.update_one(
        {'id': leftover_row['id']},
        {'$set': {'email_verification_required': True}},
    )
    leftover_verify = await routes_auth.verify_contact(VerifyEmailRequest(
        channel='PHONE', identifier=leftover_phone, phone=leftover_phone,
        username='Leftover.Dual',
        code=leftover_challenge['dev_code'], password='Leftover-Verified-9',
    ))
    assert leftover_verify['access_token']
    assert 'next_verification' not in leftover_verify
    leftover_row = await database.users.find_one({'phone_normalized': leftover_phone})
    assert leftover_row['status'] == 'ACTIVE'
    assert leftover_row['phone_verified'] is True
    assert leftover_row['email_verified'] is False
    assert leftover_row['contact_verified'] is True
    assert leftover_row['email_verification_required'] is False
    leftover_login = await routes_auth.login(LoginRequest(
        identifier=leftover_phone, phone=leftover_phone,
        password='Leftover-Verified-9',
    ))
    assert leftover_login['access_token']
    assert leftover_login['user']['status'] == 'ACTIVE'

    # Already-phone-verified PHONE_VERIFIED_EMAIL_PENDING leftovers are
    # repaired to ACTIVE on login without an email OTP.
    stuck_phone = '+919876543215'
    await database.users.insert_one({
        'id': 'stuck-dual-pending',
        'role': 'PLAYER',
        'status': 'PENDING',
        'registration_source': 'SELF_SERVICE',
        'activation_mode': routes_auth.PHONE_OTP_ACTIVATION_MODE,
        'primary_identity': stuck_phone,
        'primary_identity_channel': 'PHONE',
        'contact_verification_status': 'PHONE_VERIFIED_EMAIL_PENDING',
        'contact_verified': False,
        'phone_verified': True,
        'email_verified': False,
        'email_verification_required': True,
        'phone': stuck_phone,
        'phone_normalized': stuck_phone,
        'email': 'stuck.dual@example.com',
        'email_normalized': 'stuck.dual@example.com',
        'password_hash': auth_utils.hash_password('Stuck-Verified-9'),
        'accepted_terms': True,
        'username': 'Stuck.Dual',
        'username_key': 'stuck.dual',
    })
    stuck_login = await routes_auth.login(LoginRequest(
        identifier=stuck_phone, phone=stuck_phone,
        password='Stuck-Verified-9',
    ))
    assert stuck_login['access_token']
    assert stuck_login['user']['status'] == 'ACTIVE'
    stuck_row = await database.users.find_one({'id': 'stuck-dual-pending'})
    assert stuck_row['status'] == 'ACTIVE'
    assert stuck_row['contact_verified'] is True
    assert stuck_row['phone_verified'] is True
    assert stuck_row['email_verified'] is False
    assert stuck_row['email_verification_required'] is False

    # Existing PHONE_OTP players who sign in with a Login ID must receive the
    # stored-mobile destination so resend can deliver SMS. A typed username is
    # not an E.164 identity and previously produced 422 / a dummy challenge.
    existing_phone = '+919876543216'
    await database.users.insert_one({
        'id': 'existing-login-otp',
        'role': 'PLAYER',
        'status': 'PENDING',
        'registration_source': 'SELF_SERVICE',
        'activation_mode': routes_auth.PHONE_OTP_ACTIVATION_MODE,
        'contact_verified': False,
        'phone_verified': False,
        'email_verified': False,
        'phone': existing_phone,
        'phone_normalized': existing_phone,
        'email': 'existing.login@example.com',
        'email_normalized': 'existing.login@example.com',
        'username': 'Existing.Player',
        'username_key': 'existing.player',
        'password_hash': auth_utils.hash_password('Existing-Player-9'),
        'accepted_terms': True,
    })
    login_unverified = await expect_http_error(routes_auth.login(LoginRequest(
        identifier='Existing.Player', email='Existing.Player',
        password='Existing-Player-9',
    )), 403, 'CONTACT_NOT_VERIFIED')
    assert login_unverified.detail['channel'] == 'PHONE'
    assert login_unverified.detail['identifier'] == existing_phone
    assert login_unverified.detail['login_id'] == 'Existing.Player'
    assert await database.otp_challenges.count_documents({
        'user_id': 'existing-login-otp',
    }) == 0

    resent = await routes_auth.resend_verification(ResendVerificationRequest(
        channel='PHONE', identifier='Existing.Player',
    ))
    assert resent['channel'] == 'PHONE'
    assert resent['challenge_id']
    assert 'dev_code' in resent
    issued = await database.otp_challenges.find_one({
        'id': resent['challenge_id'],
        'user_id': 'existing-login-otp',
        'active': True,
    })
    assert issued['channel'] == 'SMS'
    assert issued['status'] == 'PENDING'

    print('Phone OTP registration: all focused checks passed')


if __name__ == '__main__':
    asyncio.run(main())
